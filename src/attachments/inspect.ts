import { TextDecoder } from "node:util";
import type { AttachmentFormat } from "./formats.js";
import { MAX_ATTACHMENT_CHARACTERS } from "./limits.js";
import { extractPdf } from "./pdf.js";

export type ExtractionContext = { protectedFiles: readonly string[] };
type TextInspection = { status: "ok"; text: string; truncated: boolean };
export type AttachmentInspection =
	| TextInspection
	| Awaited<ReturnType<typeof extractPdf>>;

export async function inspectAttachment(input: {
	format: AttachmentFormat;
	bytes: Buffer;
	context: ExtractionContext;
}): Promise<AttachmentInspection> {
	const { format, bytes, context } = input;
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
			return {
				status: "ok",
				text: text.slice(0, MAX_ATTACHMENT_CHARACTERS),
				truncated: text.length > MAX_ATTACHMENT_CHARACTERS,
			};
		}
		case "pdf_text":
			if (!/^%PDF-\d\.\d/.test(bytes.subarray(0, 8).toString("latin1")))
				throw new Error("Attachment has no valid PDF signature.");
			return extractPdf(bytes, context);
		default: {
			const exhaustive: never = format;
			return exhaustive;
		}
	}
}
