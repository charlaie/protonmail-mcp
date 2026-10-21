import type { Readable } from "node:stream";
import { isDeepStrictEqual } from "node:util";
import type { DownloadObject, MessageStructureObject } from "imapflow";
import {
	checkUidValidity,
	type MessageFilter,
	type ReadResult,
	SUMMARY_FIELDS,
} from "@/bridge/imap/reading/messages.js";
import { messageSummary } from "@/bridge/imap/serializers.js";
import type { ImapClient } from "@/bridge/imap/session.js";
import type { GetMessageInput } from "@/mail/identity.js";
import type { MessageSummary } from "@/mail/message.js";
import { MailError } from "@/shared/mail-error.js";
import {
	AttachmentMimeTypeSchema,
	type AttachmentPermission,
	attachmentExtension,
	isSafeAttachmentFilename,
} from "./formats.js";
import { MAX_ATTACHMENT_BYTES } from "./limits.js";
import {
	ATTACHMENT_ID_PATTERN,
	type GetAttachmentInput,
	MAX_ATTACHMENT_ID_LENGTH,
} from "./requests.js";

const MAX_MIME_NODES = 1000;
const MAX_LISTED_FILENAME_LENGTH = 255;
const DOWNLOAD_CHUNK_BYTES = 64 * 1024;

// ImapFlow may normalize flowed text and replace charset metadata for these
// inline text parts, so its bounded download cannot promise original bytes.
const TRANSCODED_INLINE_TEXT_TYPES = [
	"text/plain",
	"text/html",
	"text/x-amp-html",
];

type Attachment = {
	attachmentId: string;
	filename: string | undefined;
	contentType: string;
	size: number | undefined;
	charset: string | undefined;
};

type Eligibility =
	| {
			kind: "allowed";
			extension: string | null;
			filename: string;
			size: number;
	  }
	| { kind: "blocked"; reason: string };

type AttachmentInspection =
	| { kind: "allowed"; extension: string | null }
	| { kind: "blocked"; reason: string };

type InspectedMessage = {
	attachments: Attachment[];
	message: MessageSummary;
};

export type AttachmentListing = GetMessageInput & {
	untrusted: true;
	attachments: (Attachment & {
		filenameTruncated: boolean;
		sizeEncoding: "transfer_encoded";
		inspection: AttachmentInspection;
	})[];
};

export type AttachmentReadOptions = {
	allowedExtensions: readonly AttachmentPermission[];
	expectedAttachment?: AttachmentMetadata;
};

export type AttachmentMetadata = GetAttachmentInput &
	Pick<MessageSummary, "senderEmails" | "subject"> & {
		filename: string;
		contentType: string;
		mimeType: string;
		size: number;
		charset: string | undefined;
	};

export type AttachmentContent = GetAttachmentInput & {
	status: "raw";
	filename: string;
	contentType: string;
	charset: string | undefined;
	mimeType: string;
	size: number;
	bytes: Buffer;
	untrusted: true;
};

function mimeStructureLimitError() {
	return new Error("Message MIME structure exceeds the inspection limit.");
}

function isValidAttachmentId(attachmentId: string) {
	return (
		attachmentId.length <= MAX_ATTACHMENT_ID_LENGTH &&
		ATTACHMENT_ID_PATTERN.test(attachmentId)
	);
}

function attachmentPartId(node: MessageStructureObject, isRoot: boolean) {
	// A single-part message root has no part number; IMAP addresses its body as part 1.
	const attachmentId = node.part ?? (isRoot ? "1" : undefined);
	if (attachmentId === undefined || !isValidAttachmentId(attachmentId))
		throw new Error(
			"Bridge returned an attachment without a valid part identity.",
		);
	return attachmentId;
}

function attachmentAt(
	node: MessageStructureObject,
	isRoot: boolean,
): Attachment | undefined {
	const filename =
		node.dispositionParameters?.filename ?? node.parameters?.name;
	const isAttachment =
		node.disposition?.toLowerCase() === "attachment" || filename !== undefined;
	if (!isAttachment) return undefined;

	return {
		attachmentId: attachmentPartId(node, isRoot),
		filename,
		contentType: node.type.toLowerCase(),
		size: node.size,
		charset: node.parameters?.charset,
	};
}

function requireUniqueAttachmentIds(attachments: Attachment[]) {
	const attachmentIds = new Set(
		attachments.map((attachment) => attachment.attachmentId),
	);
	if (attachmentIds.size !== attachments.length)
		throw new Error("Bridge returned duplicate attachment identities.");
}

function collectAttachments(structure: MessageStructureObject): Attachment[] {
	const attachments: Attachment[] = [];
	const pending = [structure];
	let visited = 0;

	while (pending.length > 0) {
		const node = pending.pop();
		if (!node) break;

		visited += 1;
		if (visited > MAX_MIME_NODES) throw mimeStructureLimitError();

		const attachment = attachmentAt(node, node === structure);
		if (attachment) {
			// Never inspect attachments nested inside an attached message or container.
			attachments.push(attachment);
			continue;
		}

		if (node.type.toLowerCase().startsWith("multipart/")) {
			const children = node.childNodes ?? [];
			if (visited + pending.length + children.length > MAX_MIME_NODES)
				throw mimeStructureLimitError();
			pending.push(...children.slice().reverse());
		}
	}

	requireUniqueAttachmentIds(attachments);
	return attachments;
}

function isExtensionAllowed(
	extension: string | null,
	allowed: readonly AttachmentPermission[],
) {
	if (allowed.includes("*")) return true;
	return extension !== null && allowed.includes(extension);
}

function eligibility(
	attachment: Attachment,
	allowed: readonly AttachmentPermission[],
): Eligibility {
	const { filename, size } = attachment;
	if (!filename || !isSafeAttachmentFilename(filename))
		return {
			kind: "blocked",
			reason: "Missing or unsafe attachment filename.",
		};

	const extension = attachmentExtension(filename);
	if (!isExtensionAllowed(extension, allowed))
		return {
			kind: "blocked",
			reason:
				"Extension is not allowed by the read policy. Run protonmail-mcp setup to enable it.",
		};

	if (!AttachmentMimeTypeSchema.safeParse(attachment.contentType).success)
		return {
			kind: "blocked",
			reason: "Attachment MIME type is invalid or is a multipart container.",
		};

	if (size === undefined || !Number.isSafeInteger(size) || size < 0)
		return {
			kind: "blocked",
			reason: "Attachment size is unavailable or invalid.",
		};

	// BODYSTRUCTURE size is transfer-encoded, so allow bounded encoding overhead here.
	if (size > MAX_ATTACHMENT_BYTES * 2)
		return { kind: "blocked", reason: "Attachment exceeds the size limit." };

	return { kind: "allowed", extension, filename, size };
}

function listingInspection(eligible: Eligibility): AttachmentInspection {
	if (eligible.kind === "blocked") return eligible;
	return { kind: "allowed", extension: eligible.extension };
}

async function authorizedAttachments(
	client: ImapClient,
	input: GetMessageInput,
	accepts: MessageFilter,
): Promise<ReadResult<InspectedMessage>> {
	const mailbox = await client.mailboxOpen(input.mailbox, { readOnly: true });
	checkUidValidity(input.uidValidity, mailbox.uidValidity);
	const uidValidity = mailbox.uidValidity.toString();
	const uid = String(input.uid);

	// Authorize the envelope before Bridge is asked for the body structure.
	const envelope = await client.fetchOne(uid, SUMMARY_FIELDS, { uid: true });
	if (!envelope) return { kind: "not_found" };
	if (!accepts(input.mailbox, messageSummary(envelope, uidValidity)))
		return { kind: "denied" };

	const fetched = await client.fetchOne(
		uid,
		{ ...SUMMARY_FIELDS, bodyStructure: true },
		{ uid: true },
	);
	if (!fetched) return { kind: "not_found" };
	const message = messageSummary(fetched, uidValidity);
	if (!accepts(input.mailbox, message)) return { kind: "denied" };

	if (!fetched.bodyStructure)
		return {
			kind: "unavailable",
			reason: "Bridge returned no attachment structure.",
		};

	return {
		kind: "found",
		value: {
			attachments: collectAttachments(fetched.bodyStructure),
			message,
		},
	};
}

export async function listAttachments(
	client: ImapClient,
	input: GetMessageInput,
	accepts: MessageFilter,
	allowed: readonly AttachmentPermission[],
): Promise<ReadResult<AttachmentListing>> {
	const result = await authorizedAttachments(client, input, accepts);
	if (result.kind !== "found") return result;

	const attachments = result.value.attachments.map((attachment) => {
		const filenameLength = attachment.filename?.length ?? 0;
		return {
			...attachment,
			filename: attachment.filename?.slice(0, MAX_LISTED_FILENAME_LENGTH),
			filenameTruncated: filenameLength > MAX_LISTED_FILENAME_LENGTH,
			sizeEncoding: "transfer_encoded" as const,
			inspection: listingInspection(eligibility(attachment, allowed)),
		};
	});

	return {
		kind: "found",
		value: { ...input, untrusted: true, attachments },
	};
}

export async function getAttachmentMetadata(
	client: ImapClient,
	input: GetAttachmentInput,
	accepts: MessageFilter,
	allowedExtensions: readonly AttachmentPermission[],
): Promise<ReadResult<AttachmentMetadata>> {
	const result = await authorizedAttachments(client, input, accepts);
	if (result.kind !== "found") return result;

	const { attachments, message } = result.value;
	const attachment = attachments.find(
		(candidate) => candidate.attachmentId === input.attachmentId,
	);
	if (!attachment)
		return {
			kind: "unavailable",
			reason:
				"Attachment ID does not belong to this message. List attachments again.",
		};

	const eligible = eligibility(attachment, allowedExtensions);
	if (eligible.kind === "blocked")
		return { kind: "unavailable", reason: eligible.reason };

	return {
		kind: "found",
		value: {
			...input,
			filename: eligible.filename,
			contentType: attachment.contentType,
			mimeType: attachment.contentType,
			size: eligible.size,
			charset: attachment.charset,
			senderEmails: message.senderEmails,
			subject: message.subject,
		},
	};
}

function requireApprovedMetadata(
	metadata: AttachmentMetadata,
	expected: AttachmentMetadata | undefined,
) {
	if (expected && !isDeepStrictEqual(metadata, expected))
		throw new MailError(
			"APPROVAL_DENIED",
			"Attachment metadata changed before download. Review the attachment again.",
			"new_approval",
		);
}

// Revalidate the actual part headers, rather than relying only on BODYSTRUCTURE.
function requireMatchingPartHeaders(
	meta: DownloadObject["meta"],
	metadata: AttachmentMetadata,
) {
	const contentType = meta.contentType ?? "";
	if (
		meta.filename !== metadata.filename ||
		contentType !== metadata.contentType
	)
		throw new Error(
			"Downloaded attachment headers changed. List and approve the attachment again.",
		);

	const isInline = !meta.disposition || meta.disposition === "inline";
	if (isInline && TRANSCODED_INLINE_TEXT_TYPES.includes(contentType))
		throw new Error(
			"Original bytes are unavailable for this inline text part because the IMAP downloader may reformat or transcode it. Download the original file in Proton Mail.",
		);

	return contentType;
}

async function readBoundedBytes(content: Readable, limit: number) {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of content) {
		if (!Buffer.isBuffer(chunk))
			throw new Error("Bridge returned invalid attachment bytes.");
		size += chunk.length;
		if (size > limit)
			throw new Error(
				`Attachment exceeds the ${limit / (1024 * 1024)} MiB download limit.`,
			);
		chunks.push(chunk);
	}
	return Buffer.concat(chunks, size);
}

export async function getAttachment(
	client: ImapClient,
	input: GetAttachmentInput,
	accepts: MessageFilter,
	options: AttachmentReadOptions,
): Promise<ReadResult<AttachmentContent>> {
	const selected = await getAttachmentMetadata(
		client,
		input,
		accepts,
		options.allowedExtensions,
	);
	if (selected.kind !== "found") return selected;
	const metadata = selected.value;
	requireApprovedMetadata(metadata, options.expectedAttachment);

	const limit = MAX_ATTACHMENT_BYTES;
	const downloaded = await client.download(
		String(input.uid),
		input.attachmentId,
		{ uid: true, maxBytes: limit + 1, chunkSize: DOWNLOAD_CHUNK_BYTES },
	);
	if (!downloaded.content)
		throw new Error("Bridge returned no attachment content.");

	try {
		const contentType = requireMatchingPartHeaders(downloaded.meta, metadata);
		const bytes = await readBoundedBytes(downloaded.content, limit);
		return {
			kind: "found",
			value: {
				...input,
				status: "raw",
				filename: metadata.filename,
				contentType,
				charset: downloaded.meta.charset ?? metadata.charset,
				mimeType: metadata.mimeType,
				size: bytes.length,
				bytes,
				untrusted: true,
			},
		};
	} finally {
		downloaded.content.destroy();
	}
}
