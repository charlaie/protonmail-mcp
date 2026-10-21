import { z } from "zod";

const MAX_FILENAME_LENGTH = 255;

const UNSAFE_FILENAME_CHARACTERS =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control characters in untrusted filenames.
	/[\x00-\x1f\x7f/\\:%\u202a-\u202e\u2066-\u2069]/u;

export function isSafeAttachmentFilename(filename: string) {
	return (
		filename.length > 0 &&
		filename.length <= MAX_FILENAME_LENGTH &&
		filename === filename.trim() &&
		!UNSAFE_FILENAME_CHARACTERS.test(filename) &&
		!filename.startsWith(".") &&
		!filename.endsWith(".")
	);
}

export const AttachmentExtensionSchema = z
	.string()
	.min(2)
	.max(MAX_FILENAME_LENGTH - 1)
	.regex(/^\.[^.]+$/, "Expected a single filename extension such as .zip.")
	.refine(
		(extension) => isSafeAttachmentFilename(`x${extension}`),
		"Expected a safe filename extension.",
	)
	.transform((extension) => extension.toLowerCase());

export type AttachmentExtension = z.infer<typeof AttachmentExtensionSchema>;

export const AttachmentPermissionSchema = z.union([
	z.literal("*"),
	AttachmentExtensionSchema,
]);

export type AttachmentPermission = z.infer<typeof AttachmentPermissionSchema>;

export const AttachmentMimeTypeSchema = z
	.string()
	.max(127)
	.regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/)
	.refine(
		(value) => !value.startsWith("multipart/"),
		"Attachments must be MIME leaf parts, not multipart containers.",
	);

export function attachmentExtension(filename: string) {
	const dot = filename.lastIndexOf(".");
	return dot > 0 ? filename.slice(dot).toLowerCase() : null;
}
