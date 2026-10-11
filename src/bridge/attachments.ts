import type { MessageStructureObject } from "imapflow";
import {
	type AttachmentExtension,
	type AttachmentFormat,
	attachmentHeaderError,
	parseAttachmentFormat,
} from "../attachments/formats.js";
import {
	type AttachmentInspection,
	type ExtractionContext,
	inspectAttachment,
} from "../attachments/inspect.js";
import {
	checkUidValidity,
	type MessageFilter,
	type ReadResult,
	SUMMARY_FIELDS,
} from "./messages.js";
import type { GetAttachmentInput, GetMessageInput } from "./schemas.js";
import { messageSummary } from "./serializers.js";
import type { ImapClient } from "./session.js";

type Attachment = {
	attachmentId: string;
	filename: string | undefined;
	contentType: string;
	size: number | undefined;
	charset: string | undefined;
};
type Eligibility =
	| { kind: "allowed"; format: AttachmentFormat }
	| { kind: "blocked"; reason: string };
export type AttachmentReadOptions = ExtractionContext & {
	allowedExtensions: readonly AttachmentExtension[];
};

type AttachmentIdentity = GetAttachmentInput & {
	filename: string | undefined;
	contentType: string;
	size: number;
	untrusted: true;
};
type AttachmentContent = AttachmentIdentity & AttachmentInspection;

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
	allowed: readonly AttachmentExtension[],
): Eligibility {
	const format = parseAttachmentFormat(attachment.filename);
	if (!format)
		return {
			kind: "blocked",
			reason: "Missing, ambiguous, or unsupported filename extension.",
		};
	if (!allowed.includes(format.extension))
		return {
			kind: "blocked",
			reason:
				"Extension is not allowed by the read policy. Run protonmail-mcp setup to enable it.",
		};
	const headerError = attachmentHeaderError(format, attachment);
	if (headerError) return { kind: "blocked", reason: headerError };
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
	if (attachment.size > format.maxBytes * 2)
		return { kind: "blocked", reason: "Attachment exceeds the size limit." };
	return { kind: "allowed", format };
}

async function authorizedAttachments(
	client: ImapClient,
	input: GetMessageInput,
	accepts: MessageFilter,
): Promise<ReadResult<Attachment[]>> {
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
	return { kind: "found", value: collectAttachments(fetched.bodyStructure) };
}

export async function listAttachments(
	client: ImapClient,
	input: GetMessageInput,
	accepts: MessageFilter,
	allowed: readonly AttachmentExtension[],
) {
	const result = await authorizedAttachments(client, input, accepts);
	if (result.kind !== "found") return result;
	return {
		kind: "found",
		value: {
			...input,
			untrusted: true,
			attachments: result.value.map((attachment) => {
				const inspection = eligibility(attachment, allowed);
				return {
					...attachment,
					filename: attachment.filename?.slice(0, 255),
					filenameTruncated: (attachment.filename?.length ?? 0) > 255,
					sizeEncoding: "transfer_encoded",
					inspection:
						inspection.kind === "allowed"
							? { kind: "allowed", extension: inspection.format.extension }
							: inspection,
				};
			}),
		},
	} satisfies ReadResult<unknown>;
}

export async function getAttachment(
	client: ImapClient,
	input: GetAttachmentInput,
	accepts: MessageFilter,
	options: AttachmentReadOptions,
): Promise<ReadResult<AttachmentContent>> {
	const result = await authorizedAttachments(client, input, accepts);
	if (result.kind !== "found") return result;
	const attachment = result.value.find(
		(item) => item.attachmentId === input.attachmentId,
	);
	if (!attachment)
		return {
			kind: "unavailable",
			reason:
				"Attachment ID does not belong to this message. List attachments again.",
		} satisfies ReadResult<never>;
	const inspection = eligibility(attachment, options.allowedExtensions);
	if (inspection.kind === "blocked")
		return {
			kind: "unavailable",
			reason: inspection.reason,
		} satisfies ReadResult<never>;
	const format = inspection.format;
	const limit = format.maxBytes;
	const downloaded = await client.download(
		String(input.uid),
		attachment.attachmentId,
		{ uid: true, maxBytes: limit + 1, chunkSize: 64 * 1024 },
	);
	if (!downloaded.content)
		throw new Error("Bridge returned no attachment content.");
	try {
		// Revalidate the actual part headers, rather than relying only on BODYSTRUCTURE.
		const contentType = downloaded.meta.contentType ?? "";
		const headerError = attachmentHeaderError(format, {
			contentType,
			charset: downloaded.meta.charset ?? attachment.charset,
		});
		if (
			parseAttachmentFormat(downloaded.meta.filename)?.extension !==
				format.extension ||
			headerError
		)
			throw new Error(
				`Downloaded attachment headers do not match its allowed type.${headerError ? ` ${headerError}` : ""}`,
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
		const identity = {
			...input,
			filename: attachment.filename,
			contentType,
			size,
			untrusted: true,
		} satisfies AttachmentIdentity;
		return {
			kind: "found",
			value: {
				...identity,
				...(await inspectAttachment({ format, bytes, context: options })),
			},
		};
	} finally {
		downloaded.content.destroy();
	}
}
