import { isDeepStrictEqual } from "node:util";
import type { Attachment, ParsedMail } from "mailparser";
import type { SendMailOptions } from "nodemailer";
import { z } from "zod";
import { MailError } from "../../../shared/mail-error.js";
import {
	type AttachmentPayload,
	AttachmentPayloadSchema,
	type InlineImagePayload,
	InlineImagePayloadSchema,
	mediaManifest,
	type OutgoingPart,
	outgoingMedia,
} from "./model.js";

type MailAttachment = NonNullable<SendMailOptions["attachments"]>[number];

type InlinePart = Extract<OutgoingPart, { kind: "inline" }>;

const INLINE_ALT_HEADER = "X-Protonmail-Mcp-Inline-Alt";

const HTML_ENTITIES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

const ContentTypeHeaderSchema = z.object({
	value: z.string(),
	params: z.record(z.string(), z.string()),
});

type ContentTypeHeader = z.infer<typeof ContentTypeHeaderSchema>;

function escapeHtml(value: string) {
	return value.replace(
		/[&<>"']/g,
		(character) => HTML_ENTITIES[character] ?? character,
	);
}

function normalizeLineEndings(value: string) {
	return value.replace(/\r\n?/g, "\n");
}

function inlineParts(parts: OutgoingPart[]): InlinePart[] {
	return parts.filter((part) => part.kind === "inline");
}

function imageParagraph(part: InlinePart) {
	return `<p><img src="cid:${part.cid}" alt="${escapeHtml(part.file.alt)}"></p>`;
}

export function inlineHtml(text: string, parts: OutgoingPart[]) {
	const images = inlineParts(parts);
	if (!images.length) return undefined;

	const textHtml = escapeHtml(normalizeLineEndings(text)).replace(
		/\n/g,
		"<br>",
	);
	const imagesHtml = images.map(imageParagraph).join("");
	return `<html><body><p>${textHtml}</p>${imagesHtml}</body></html>`;
}

function mimeContentType(file: AttachmentPayload) {
	if (!file.charset) return file.contentType;
	return `${file.contentType}; charset=${file.charset}`;
}

function inlineImageOptions(part: InlinePart) {
	return {
		cid: part.cid,
		headers: {
			[INLINE_ALT_HEADER]: Buffer.from(part.file.alt).toString("base64"),
		},
	};
}

function mailAttachment(part: OutgoingPart): MailAttachment {
	const isInline = part.kind === "inline";
	return {
		filename: part.file.filename,
		contentType: mimeContentType(part.file),
		content: Buffer.from(part.file.contentBase64, "base64"),
		contentDisposition: isInline ? "inline" : "attachment",
		contentTransferEncoding: "base64",
		...(part.kind === "inline" ? inlineImageOptions(part) : {}),
	};
}

export function mediaMailOptions(text: string, parts: OutgoingPart[] = []) {
	const hasInlineImages = parts.some((part) => part.kind === "inline");
	return {
		text: hasInlineImages ? Buffer.from(text, "utf8") : text,
		html: inlineHtml(text, parts),
		attachments: parts.map(mailAttachment),
		disableFileAccess: true,
		disableUrlAccess: true,
	};
}

function unsupportedContent(message: string) {
	return new MailError("UNSUPPORTED_CONTENT", message, "never");
}

function isInlineAttachment(attachment: Attachment) {
	return attachment.contentDisposition === "inline" || Boolean(attachment.cid);
}

function contentTypeHeader(
	attachment: Attachment,
): ContentTypeHeader | undefined {
	const rawHeader = attachment.headers.get("content-type");
	if (rawHeader === undefined) return undefined;

	const header = ContentTypeHeaderSchema.safeParse(rawHeader);
	if (!header.success)
		throw unsupportedContent(
			"Attachment Content-Type header is ambiguous or unsupported.",
		);

	const hasUnsupportedParameter = Object.keys(header.data.params).some(
		(key) => key !== "name" && key !== "charset",
	);
	if (hasUnsupportedParameter)
		throw unsupportedContent(
			"Attachment MIME parameters are unsupported. Edit this draft in Proton Mail.",
		);

	return header.data;
}

function parsedFile(attachment: Attachment) {
	const header = contentTypeHeader(attachment);
	const charset = header?.params.charset;
	return {
		...(charset ? { charset } : {}),
		filename: attachment.filename,
		contentType: header ? header.value : attachment.contentType,
		contentBase64: attachment.content.toString("base64"),
	};
}

function inlineAlt(attachment: Attachment) {
	const encodedAlt = attachment.headers.get(INLINE_ALT_HEADER.toLowerCase());
	if (typeof encodedAlt !== "string")
		throw unsupportedContent(
			"Inline image metadata is unsupported. Edit this draft in Proton Mail.",
		);

	const alt = Buffer.from(encodedAlt, "base64");
	if (alt.toString("base64") !== encodedAlt)
		throw unsupportedContent("Inline image description is invalid.");
	return alt.toString("utf8");
}

function requireGeneratedContentIds(
	original: ParsedMail,
	parts: OutgoingPart[],
) {
	const originalCids = original.attachments
		.filter(isInlineAttachment)
		.map((attachment) => attachment.cid);
	const changed = inlineParts(parts).some(
		(part, index) => part.cid !== originalCids[index],
	);
	if (changed)
		throw unsupportedContent(
			"Inline image Content-ID does not match the supported generated body.",
		);
}

function requireGeneratedHtml(original: ParsedMail, parts: OutgoingPart[]) {
	const originalHtml =
		typeof original.html === "string"
			? normalizeLineEndings(original.html).trim()
			: undefined;
	if (originalHtml !== inlineHtml(original.text ?? "", parts))
		throw unsupportedContent(
			"Arbitrary HTML drafts are unsupported. Edit this draft in Proton Mail.",
		);
}

export function parsedMedia(original: ParsedMail): OutgoingPart[] {
	const attachments: AttachmentPayload[] = [];
	const inlineImages: InlineImagePayload[] = [];
	for (const attachment of original.attachments) {
		const file = parsedFile(attachment);
		if (isInlineAttachment(attachment)) {
			const alt = inlineAlt(attachment);
			inlineImages.push(InlineImagePayloadSchema.parse({ ...file, alt }));
		} else {
			attachments.push(AttachmentPayloadSchema.parse(file));
		}
	}

	const parts = outgoingMedia({ attachments, inlineImages });
	requireGeneratedContentIds(original, parts);
	requireGeneratedHtml(original, parts);
	return parts;
}

export function verifyComposedMedia(
	original: ParsedMail,
	intended: OutgoingPart[],
) {
	const preserved = isDeepStrictEqual(
		mediaManifest(parsedMedia(original)),
		mediaManifest(intended),
	);
	if (!preserved)
		throw unsupportedContent(
			"Composed MIME did not preserve every file and inline image. No draft was appended.",
		);
}
