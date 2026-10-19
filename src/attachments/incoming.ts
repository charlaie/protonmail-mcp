import { isDeepStrictEqual } from "node:util";
import type { MessageStructureObject } from "imapflow";
import {
	checkUidValidity,
	type MessageFilter,
	type ReadResult,
	SUMMARY_FIELDS,
} from "../bridge/messages.js";
import { messageSummary } from "../bridge/serializers.js";
import type { ImapClient } from "../bridge/session.js";
import type { GetMessageInput } from "../mail/identity.js";
import type { MessageSummary } from "../mail/message.js";
import { MailError } from "../shared/mail-error.js";
import {
	AttachmentMimeTypeSchema,
	type AttachmentPermission,
	attachmentExtension,
	isSafeAttachmentFilename,
} from "./formats.js";
import { MAX_ATTACHMENT_BYTES } from "./limits.js";
import type { GetAttachmentInput } from "./requests.js";

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

function collectAttachments(structure: MessageStructureObject): Attachment[] {
	const attachments: Attachment[] = [];
	const pending = [structure];
	let visited = 0;
	while (pending.length) {
		const node = pending.pop();
		if (!node) break;
		if (++visited > 1000)
			throw new Error("Message MIME structure exceeds the inspection limit.");
		const filename =
			node.dispositionParameters?.filename ?? node.parameters?.name;
		const isAttachment =
			node.disposition?.toLowerCase() === "attachment" ||
			filename !== undefined;
		if (isAttachment) {
			const attachmentId = node.part ?? (node === structure ? "1" : undefined);
			if (
				!attachmentId ||
				attachmentId.length > 100 ||
				!/^[1-9]\d*(?:\.[1-9]\d*)*$/.test(attachmentId)
			)
				throw new Error(
					"Bridge returned an attachment without a valid part identity.",
				);
			attachments.push({
				attachmentId,
				filename,
				contentType: node.type.toLowerCase(),
				size: node.size,
				charset: node.parameters?.charset,
			});
			// Never inspect attachments nested inside an attached message or container.
		} else if (node.type.toLowerCase().startsWith("multipart/")) {
			if (visited + pending.length + (node.childNodes?.length ?? 0) > 1000)
				throw new Error("Message MIME structure exceeds the inspection limit.");
			pending.push(...(node.childNodes ?? []).slice().reverse());
		}
	}
	if (
		new Set(attachments.map((attachment) => attachment.attachmentId)).size !==
		attachments.length
	)
		throw new Error("Bridge returned duplicate attachment identities.");
	return attachments;
}

function eligibility(
	attachment: Attachment,
	allowed: readonly AttachmentPermission[],
): Eligibility {
	if (!attachment.filename || !isSafeAttachmentFilename(attachment.filename))
		return {
			kind: "blocked",
			reason: "Missing or unsafe attachment filename.",
		};
	const extension = attachmentExtension(attachment.filename);
	if (
		!allowed.includes("*") &&
		(extension === null || !allowed.includes(extension))
	)
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
	if (
		attachment.size === undefined ||
		!Number.isSafeInteger(attachment.size) ||
		attachment.size < 0
	)
		return {
			kind: "blocked",
			reason: "Attachment size is unavailable or invalid.",
		};
	// BODYSTRUCTURE size is transfer-encoded, so allow bounded encoding overhead here.
	if (attachment.size > MAX_ATTACHMENT_BYTES * 2)
		return { kind: "blocked", reason: "Attachment exceeds the size limit." };
	return {
		kind: "allowed",
		extension,
		filename: attachment.filename,
		size: attachment.size,
	};
}

async function authorizedAttachments(
	client: ImapClient,
	input: GetMessageInput,
	accepts: MessageFilter,
): Promise<ReadResult<{ attachments: Attachment[]; message: MessageSummary }>> {
	const mailbox = await client.mailboxOpen(input.mailbox, { readOnly: true });
	checkUidValidity(input.uidValidity, mailbox.uidValidity);
	const summary = await client.fetchOne(String(input.uid), SUMMARY_FIELDS, {
		uid: true,
	});
	if (!summary) return { kind: "not_found" };
	if (
		!accepts(
			input.mailbox,
			messageSummary(summary, mailbox.uidValidity.toString()),
		)
	)
		return { kind: "denied" };
	const fetched = await client.fetchOne(
		String(input.uid),
		{ ...SUMMARY_FIELDS, bodyStructure: true },
		{ uid: true },
	);
	if (!fetched) return { kind: "not_found" };
	if (
		!accepts(
			input.mailbox,
			messageSummary(fetched, mailbox.uidValidity.toString()),
		)
	)
		return { kind: "denied" };
	if (!fetched.bodyStructure)
		return {
			kind: "unavailable",
			reason: "Bridge returned no attachment structure.",
		};
	return {
		kind: "found",
		value: {
			attachments: collectAttachments(fetched.bodyStructure),
			message: messageSummary(fetched, mailbox.uidValidity.toString()),
		},
	};
}

export async function listAttachments(
	client: ImapClient,
	input: GetMessageInput,
	accepts: MessageFilter,
	allowed: readonly AttachmentPermission[],
) {
	const result = await authorizedAttachments(client, input, accepts);
	if (result.kind !== "found") return result;
	return {
		kind: "found",
		value: {
			...input,
			untrusted: true,
			attachments: result.value.attachments.map((attachment) => {
				const inspection = eligibility(attachment, allowed);
				return {
					...attachment,
					filename: attachment.filename?.slice(0, 255),
					filenameTruncated: (attachment.filename?.length ?? 0) > 255,
					sizeEncoding: "transfer_encoded",
					inspection:
						inspection.kind === "allowed"
							? { kind: "allowed", extension: inspection.extension }
							: inspection,
				};
			}),
		},
	} satisfies ReadResult<unknown>;
}

export async function getAttachmentMetadata(
	client: ImapClient,
	input: GetAttachmentInput,
	accepts: MessageFilter,
	allowedExtensions: readonly AttachmentPermission[],
): Promise<ReadResult<AttachmentMetadata>> {
	const result = await authorizedAttachments(client, input, accepts);
	if (result.kind !== "found") return result;
	const attachment = result.value.attachments.find(
		(item) => item.attachmentId === input.attachmentId,
	);
	if (!attachment)
		return {
			kind: "unavailable",
			reason:
				"Attachment ID does not belong to this message. List attachments again.",
		} satisfies ReadResult<never>;
	const inspection = eligibility(attachment, allowedExtensions);
	if (inspection.kind === "blocked")
		return {
			kind: "unavailable",
			reason: inspection.reason,
		} satisfies ReadResult<never>;
	return {
		kind: "found",
		value: {
			...input,
			filename: inspection.filename,
			contentType: attachment.contentType,
			mimeType: attachment.contentType,
			size: inspection.size,
			charset: attachment.charset,
			senderEmails: result.value.message.senderEmails,
			subject: result.value.message.subject,
		},
	};
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
	if (
		options.expectedAttachment &&
		!isDeepStrictEqual(metadata, options.expectedAttachment)
	)
		throw new MailError(
			"APPROVAL_DENIED",
			"Attachment metadata changed before download. Review the attachment again.",
			"new_approval",
		);
	const limit = MAX_ATTACHMENT_BYTES;
	const downloaded = await client.download(
		String(input.uid),
		input.attachmentId,
		{ uid: true, maxBytes: limit + 1, chunkSize: 64 * 1024 },
	);
	if (!downloaded.content)
		throw new Error("Bridge returned no attachment content.");
	try {
		// Revalidate the actual part headers, rather than relying only on BODYSTRUCTURE.
		const contentType = downloaded.meta.contentType ?? "";
		if (
			downloaded.meta.filename !== metadata.filename ||
			contentType !== metadata.contentType
		)
			throw new Error(
				"Downloaded attachment headers changed. List and approve the attachment again.",
			);
		// ImapFlow may normalize flowed text and replace charset metadata for
		// these inline text parts. Its bounded download cannot promise original bytes.
		if (
			["text/plain", "text/html", "text/x-amp-html"].includes(contentType) &&
			(!downloaded.meta.disposition || downloaded.meta.disposition === "inline")
		)
			throw new Error(
				"Original bytes are unavailable for this inline text part because the IMAP downloader may reformat or transcode it. Download the original file in Proton Mail.",
			);
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of downloaded.content) {
			if (!Buffer.isBuffer(chunk))
				throw new Error("Bridge returned invalid attachment bytes.");
			size += chunk.length;
			if (size > limit)
				throw new Error(
					`Attachment exceeds the ${limit / (1024 * 1024)} MiB download limit.`,
				);
			chunks.push(chunk);
		}
		const bytes = Buffer.concat(chunks, size);
		return {
			kind: "found",
			value: {
				...input,
				status: "raw",
				filename: metadata.filename,
				contentType,
				charset: downloaded.meta.charset ?? metadata.charset,
				mimeType: metadata.mimeType,
				size,
				bytes,
				untrusted: true,
			},
		};
	} finally {
		downloaded.content.destroy();
	}
}
