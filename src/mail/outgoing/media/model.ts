import { createHash } from "node:crypto";
import { z } from "zod";
import {
	AttachmentMimeTypeSchema,
	isSafeAttachmentFilename,
} from "../../attachments/formats.js";
import { validInlineImage } from "./images.js";

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_MEDIA_BYTES = 6 * 1024 * 1024;
export const MAX_MEDIA_PARTS = 20;

function isCanonicalBase64WithinFileLimit(value: string) {
	const bytes = Buffer.from(value, "base64");
	return bytes.length <= MAX_FILE_BYTES && bytes.toString("base64") === value;
}

const Base64Schema = z
	.string()
	.max(4 * Math.ceil(MAX_FILE_BYTES / 3))
	.regex(/^[A-Za-z0-9+/]*={0,2}$/)
	.refine(
		isCanonicalBase64WithinFileLimit,
		"Expected canonical base64 containing at most 5 MiB.",
	);

export const AttachmentPayloadSchema = z
	.object({
		filename: z
			.string()
			.refine(
				isSafeAttachmentFilename,
				"Expected a safe filename, not a path.",
			),
		contentType: AttachmentMimeTypeSchema.describe(
			"MIME type without parameters, for example application/pdf.",
		),
		charset: z
			.string()
			.max(80)
			.regex(/^[a-zA-Z0-9._-]+$/)
			.optional()
			.describe("Optional MIME character set for an attached text file."),
		contentBase64: Base64Schema.describe(
			"Original file bytes in canonical base64. No paths or URLs are read.",
		),
	})
	.strict();

export const InlineImagePayloadSchema = AttachmentPayloadSchema.extend({
	contentType: z.enum(["image/png", "image/jpeg", "image/gif"]),
	alt: z
		.string()
		.min(1)
		.max(128)
		.describe(
			"Description of the inline image shown in send approval and image alternatives.",
		),
}).refine(
	(file) => validInlineImage(decodedBytes(file), file.contentType),
	"Inline image must have a matching PNG, JPEG or GIF signature and dimensions at most 4096 by 4096.",
);

export const MediaInputFields = {
	attachments: z
		.array(AttachmentPayloadSchema)
		.max(MAX_MEDIA_PARTS)
		.optional()
		.describe(
			"Files to attach. On edit, omit to preserve files or [] to clear them.",
		),
	inlineImages: z
		.array(InlineImagePayloadSchema)
		.max(MAX_MEDIA_PARTS)
		.optional()
		.describe(
			"Images displayed after the escaped text body, with a plain-text alternative. On edit, omit to preserve or [] to clear.",
		),
};

export type AttachmentPayload = z.infer<typeof AttachmentPayloadSchema>;
export type InlineImagePayload = z.infer<typeof InlineImagePayloadSchema>;

export type MediaInput = {
	attachments?: AttachmentPayload[];
	inlineImages?: InlineImagePayload[];
};

function decodedBytes(file: Pick<AttachmentPayload, "contentBase64">) {
	return Buffer.from(file.contentBase64, "base64");
}

export function withinMediaLimits(input: MediaInput) {
	const files = [...(input.attachments ?? []), ...(input.inlineImages ?? [])];
	if (files.length > MAX_MEDIA_PARTS) return false;

	const totalBytes = files.reduce(
		(total, file) => total + decodedBytes(file).length,
		0,
	);
	return totalBytes <= MAX_MEDIA_BYTES;
}

const ContentIdSchema = z
	.string()
	.regex(/^inline-[a-f0-9]{64}-\d+@protonmail-mcp\.local$/);

export const OutgoingPartSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("attachment"), file: AttachmentPayloadSchema }),
	z.object({
		kind: z.literal("inline"),
		file: InlineImagePayloadSchema,
		cid: ContentIdSchema,
	}),
]);

export type OutgoingPart = z.infer<typeof OutgoingPartSchema>;

export const OutgoingMediaSchema = z
	.array(OutgoingPartSchema)
	.max(MAX_MEDIA_PARTS)
	.refine(
		(parts) =>
			withinMediaLimits({ attachments: parts.map((part) => part.file) }),
		"Combined media exceeds 6 MiB.",
	);

export function fileDigest(file: AttachmentPayload) {
	return createHash("sha256").update(decodedBytes(file)).digest("hex");
}

export function outgoingMedia(input: MediaInput): OutgoingPart[] {
	const attachmentParts = (input.attachments ?? []).map((file) => ({
		kind: "attachment",
		file,
	}));
	const inlineParts = (input.inlineImages ?? []).map((file, index) => ({
		kind: "inline",
		file,
		cid: `inline-${fileDigest(file)}-${index}@protonmail-mcp.local`,
	}));
	return OutgoingMediaSchema.parse([...attachmentParts, ...inlineParts]);
}

const MetadataFields = {
	...AttachmentPayloadSchema.omit({ contentBase64: true }).shape,
	size: z.number().int().min(0).max(MAX_FILE_BYTES),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
};

export const MediaMetadataSchema = z.discriminatedUnion("kind", [
	z.object({ ...MetadataFields, kind: z.literal("attachment") }),
	z.object({
		...MetadataFields,
		kind: z.literal("inline"),
		contentType: InlineImagePayloadSchema.shape.contentType,
		alt: InlineImagePayloadSchema.shape.alt,
		cid: ContentIdSchema,
	}),
]);

type MediaMetadata = z.infer<typeof MediaMetadataSchema>;

function fileMetadata(file: AttachmentPayload) {
	return {
		filename: file.filename,
		contentType: file.contentType,
		...(file.charset ? { charset: file.charset } : {}),
		size: decodedBytes(file).length,
		sha256: fileDigest(file),
	};
}

function partMetadata(part: OutgoingPart): MediaMetadata {
	const metadata = fileMetadata(part.file);
	if (part.kind === "attachment") return { ...metadata, kind: part.kind };

	return {
		...metadata,
		contentType: part.file.contentType,
		kind: part.kind,
		cid: part.cid,
		alt: part.file.alt,
	};
}

export function mediaManifest(parts: OutgoingPart[] = []): MediaMetadata[] {
	return parts.map(partMetadata);
}
