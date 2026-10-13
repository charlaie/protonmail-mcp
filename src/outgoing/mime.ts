import type { ParsedMail } from "mailparser";
import type { SendMailOptions } from "nodemailer";
import { z } from "zod";
import { MailError } from "../shared/mail-error.js";
import {
	AttachmentPayloadSchema,
	InlineImagePayloadSchema,
	type OutgoingPart,
	outgoingMedia,
} from "./media.js";

function escapeHtml(value: string) {
	return value.replace(
		/[&<>"']/g,
		(character) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				character
			] ?? character,
	);
}
export function inlineHtml(text: string, parts: OutgoingPart[]) {
	const images = parts.filter((part) => part.kind === "inline");
	if (!images.length) return undefined;
	return `<html><body><p>${escapeHtml(text.replace(/\r\n?/g, "\n")).replace(/\n/g, "<br>")}</p>${images.map((part) => `<p><img src="cid:${part.cid}" alt="${escapeHtml(part.file.alt)}"></p>`).join("")}</body></html>`;
}
export function mediaMailOptions(text: string, parts: OutgoingPart[] = []) {
	return {
		text: parts.some((part) => part.kind === "inline")
			? Buffer.from(text, "utf8")
			: text,
		html: inlineHtml(text, parts),
		attachments: parts.map(
			(part): NonNullable<SendMailOptions["attachments"]>[number] => ({
				filename: part.file.filename,
				contentType: part.file.charset
					? `${part.file.contentType}; charset=${part.file.charset}`
					: part.file.contentType,
				content: Buffer.from(part.file.contentBase64, "base64"),
				contentDisposition: part.kind === "inline" ? "inline" : "attachment",
				contentTransferEncoding: "base64",
				...(part.kind === "inline"
					? {
							cid: part.cid,
							headers: {
								"X-Protonmail-Mcp-Inline-Alt": Buffer.from(
									part.file.alt,
								).toString("base64"),
							},
						}
					: {}),
			}),
		),
		disableFileAccess: true,
		disableUrlAccess: true,
	};
}
const ContentTypeHeaderSchema = z.object({
	value: z.string(),
	params: z.record(z.string(), z.string()),
});
export function parsedMedia(original: ParsedMail): OutgoingPart[] {
	const attachments = [];
	const inlineImages = [];
	for (const attachment of original.attachments) {
		const rawHeader = attachment.headers.get("content-type");
		const header = ContentTypeHeaderSchema.safeParse(rawHeader);
		if (rawHeader !== undefined && !header.success)
			throw new MailError(
				"UNSUPPORTED_CONTENT",
				"Attachment Content-Type header is ambiguous or unsupported.",
				"never",
			);
		if (
			header.success &&
			Object.keys(header.data.params).some(
				(key) => key !== "name" && key !== "charset",
			)
		)
			throw new MailError(
				"UNSUPPORTED_CONTENT",
				"Attachment MIME parameters are unsupported. Edit this draft in Proton Mail.",
				"never",
			);
		const file = {
			...(header.success && header.data.params.charset
				? { charset: header.data.params.charset }
				: {}),
			filename: attachment.filename,
			contentType: header.success ? header.data.value : attachment.contentType,
			contentBase64: attachment.content.toString("base64"),
		};
		if (attachment.contentDisposition === "inline" || attachment.cid) {
			const encodedAlt = attachment.headers.get("x-protonmail-mcp-inline-alt");
			if (typeof encodedAlt !== "string")
				throw new MailError(
					"UNSUPPORTED_CONTENT",
					"Inline image metadata is unsupported. Edit this draft in Proton Mail.",
					"never",
				);
			const alt = Buffer.from(encodedAlt, "base64");
			if (alt.toString("base64") !== encodedAlt)
				throw new MailError(
					"UNSUPPORTED_CONTENT",
					"Inline image description is invalid.",
					"never",
				);
			inlineImages.push(
				InlineImagePayloadSchema.parse({ ...file, alt: alt.toString("utf8") }),
			);
		} else attachments.push(AttachmentPayloadSchema.parse(file));
	}
	const parts = outgoingMedia({ attachments, inlineImages });
	const originalCids = original.attachments
		.filter(
			(attachment) =>
				attachment.contentDisposition === "inline" || attachment.cid,
		)
		.map((attachment) => attachment.cid);
	if (
		parts
			.filter((part) => part.kind === "inline")
			.some((part, index) => part.cid !== originalCids[index])
	)
		throw new MailError(
			"UNSUPPORTED_CONTENT",
			"Inline image Content-ID does not match the supported generated body.",
			"never",
		);
	const expectedHtml = inlineHtml(original.text ?? "", parts);
	if (
		(typeof original.html === "string"
			? original.html.replace(/\r\n?/g, "\n").trim()
			: undefined) !== expectedHtml
	)
		throw new MailError(
			"UNSUPPORTED_CONTENT",
			"Arbitrary HTML drafts are unsupported. Edit this draft in Proton Mail.",
			"never",
		);
	return parts;
}
