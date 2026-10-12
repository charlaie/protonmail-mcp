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
	mimeTypes: readonly [string, ...string[]];
	maxBytes: number;
};

// Every supported extension must explicitly choose its MIME types and byte budget.
// Adding an extension to the schema without a definition is a compile error.
const FORMAT_DEFINITIONS = {
	".txt": {
		mimeTypes: ["text/plain"],
		maxBytes: MAX_TEXT_BYTES,
	},
	".csv": {
		mimeTypes: ["text/csv", "text/plain", "application/csv"],
		maxBytes: MAX_TEXT_BYTES,
	},
	".tsv": {
		mimeTypes: ["text/tab-separated-values", "text/plain"],
		maxBytes: MAX_TEXT_BYTES,
	},
	".md": {
		mimeTypes: ["text/markdown", "text/plain"],
		maxBytes: MAX_TEXT_BYTES,
	},
	".json": {
		mimeTypes: ["application/json", "text/json", "text/plain"],
		maxBytes: MAX_TEXT_BYTES,
	},
	".pdf": {
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
	headers: { contentType: string },
) {
	// Generic binary MIME types are common for attachments with an allowed extension.
	if (
		headers.contentType !== "application/octet-stream" &&
		!format.mimeTypes.includes(headers.contentType)
	)
		return "MIME type does not match the filename extension.";
	return undefined;
}
