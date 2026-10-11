import { z } from "zod";
import { MAX_PDF_BYTES, MAX_TEXT_BYTES } from "./limits.js";

export const AttachmentExtensionSchema = z.enum([
	".txt",
	".csv",
	".tsv",
	".md",
	".json",
	".pdf",
]);
export type AttachmentExtension = z.infer<typeof AttachmentExtensionSchema>;

type FormatDefinition = {
	mimeTypes: readonly string[];
	maxBytes: number;
} & (
	| { decoder: "utf8_text"; charsets: readonly string[] }
	| { decoder: "pdf_text" }
);
const TEXT_CHARSETS = ["utf8", "utf-8", "ascii", "usascii", "us-ascii"];

// Every supported extension must explicitly choose its decoder and byte budget.
// Adding an extension to the schema without a definition is a compile error.
const FORMAT_DEFINITIONS = {
	".txt": {
		decoder: "utf8_text",
		mimeTypes: ["text/plain"],
		maxBytes: MAX_TEXT_BYTES,
		charsets: TEXT_CHARSETS,
	},
	".csv": {
		decoder: "utf8_text",
		mimeTypes: ["text/csv", "text/plain", "application/csv"],
		maxBytes: MAX_TEXT_BYTES,
		charsets: TEXT_CHARSETS,
	},
	".tsv": {
		decoder: "utf8_text",
		mimeTypes: ["text/tab-separated-values", "text/plain"],
		maxBytes: MAX_TEXT_BYTES,
		charsets: TEXT_CHARSETS,
	},
	".md": {
		decoder: "utf8_text",
		mimeTypes: ["text/markdown", "text/plain"],
		maxBytes: MAX_TEXT_BYTES,
		charsets: TEXT_CHARSETS,
	},
	".json": {
		decoder: "utf8_text",
		mimeTypes: ["application/json", "text/json", "text/plain"],
		maxBytes: MAX_TEXT_BYTES,
		charsets: TEXT_CHARSETS,
	},
	".pdf": {
		decoder: "pdf_text",
		mimeTypes: ["application/pdf"],
		maxBytes: MAX_PDF_BYTES,
	},
} satisfies Record<AttachmentExtension, FormatDefinition>;

export type AttachmentFormat = FormatDefinition & {
	extension: AttachmentExtension;
};

export function parseAttachmentFormat(
	filename: string | undefined,
): AttachmentFormat | undefined {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control characters in untrusted filenames.
	const unsafeFilename = /[\x00-\x1f\x7f/\\:%\u202a-\u202e\u2066-\u2069]/u;
	if (
		!filename ||
		filename.length > 255 ||
		filename !== filename.trim() ||
		unsafeFilename.test(filename) ||
		filename.startsWith(".") ||
		filename.endsWith(".")
	)
		return undefined;
	const dot = filename.lastIndexOf(".");
	if (dot <= 0) return undefined;
	const extension = AttachmentExtensionSchema.safeParse(
		filename.slice(dot).toLowerCase(),
	);
	return extension.success
		? { ...FORMAT_DEFINITIONS[extension.data], extension: extension.data }
		: undefined;
}

export function attachmentHeaderError(
	format: AttachmentFormat,
	headers: { contentType: string; charset: string | undefined },
) {
	// Octet-stream is common for valid attachments. Content validation is still mandatory.
	if (
		headers.contentType !== "application/octet-stream" &&
		!format.mimeTypes.includes(headers.contentType)
	)
		return "MIME type does not match the filename extension.";
	switch (format.decoder) {
		case "utf8_text":
			return headers.charset &&
				!format.charsets.includes(headers.charset.toLowerCase())
				? "Only UTF-8 and ASCII text attachments are supported."
				: undefined;
		case "pdf_text":
			return undefined;
		default: {
			const exhaustive: never = format;
			return exhaustive;
		}
	}
}
