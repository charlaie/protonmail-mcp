import { TextDecoder } from "node:util";
import type { AttachmentFormat } from "./formats.js";
import { MAX_ATTACHMENT_CHARACTERS } from "./limits.js";
import { extractPdf } from "./pdf.js";

export type ExtractionContext = { protectedFiles: readonly string[] };
type TextInspection = { status: "ok"; text: string; truncated: boolean };
export type AttachmentInspection =
	| TextInspection
	| Awaited<ReturnType<typeof extractPdf>>
	| { status: "raw"; bytes: Buffer; mimeType: string };

type ValidatedContent = { kind: "text"; text: string } | { kind: "pdf" };

function validateContent(input: {
	format: AttachmentFormat;
	bytes: Buffer;
}): ValidatedContent {
	const { format, bytes } = input;
	if (bytes.length > format.maxBytes)
		throw new Error("Attachment exceeds its decoded byte limit.");
	switch (format.decoder) {
		case "utf8_text": {
			let text: string;
			try {
				text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			} catch {
				throw new Error("Attachment is not valid UTF-8 text.");
			}
			// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject binary/control data while preserving tabs and line endings.
			if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text))
				throw new Error("Attachment contains binary or control data.");
			return { kind: "text", text };
		}
		case "pdf_text":
			if (!/^%PDF-\d\.\d/.test(bytes.subarray(0, 8).toString("latin1")))
				throw new Error("Attachment has no valid PDF signature.");
			return { kind: "pdf" };
		default: {
			const exhaustive: never = format;
			return exhaustive;
		}
	}
}

export async function inspectAttachment(input: {
	format: AttachmentFormat;
	bytes: Buffer;
	context: ExtractionContext;
	outputFormat: "text" | "raw";
}): Promise<AttachmentInspection> {
	const { format, bytes, context, outputFormat } = input;
	const content = validateContent({ format, bytes });
	if (outputFormat === "raw")
		return { status: "raw", bytes, mimeType: format.mimeTypes[0] };
	switch (content.kind) {
		case "text":
			return {
				status: "ok",
				text: content.text.slice(0, MAX_ATTACHMENT_CHARACTERS),
				truncated: content.text.length > MAX_ATTACHMENT_CHARACTERS,
			};
		case "pdf":
			return extractPdf(bytes, context);
		default: {
			const exhaustive: never = content;
			return exhaustive;
		}
	}
}
