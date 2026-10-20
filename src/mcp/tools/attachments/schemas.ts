import { z } from "zod";
import { GetAttachmentSchema } from "../../../mail/attachments/requests.js";
import { GetMessageSchema } from "../../../mail/identity.js";
import { ToolErrorSchema } from "../../../shared/mail-error.js";

const IdentitySchema = GetMessageSchema.extend({
	attachmentId: GetAttachmentSchema.shape.attachmentId,
	filename: z.string(),
	contentType: z.string(),
	charset: z.string().optional(),
	size: z.number(),
	untrusted: z.literal(true),
});
export const AttachmentListOutputSchema = z.union([
	GetMessageSchema.extend({
		untrusted: z.literal(true),
		attachments: z.array(
			z.object({
				attachmentId: z.string(),
				filename: z.string().optional(),
				filenameTruncated: z.boolean(),
				contentType: z.string(),
				size: z.number().optional(),
				charset: z.string().optional(),
				sizeEncoding: z.literal("transfer_encoded"),
				inspection: z.discriminatedUnion("kind", [
					z.object({
						kind: z.literal("allowed"),
						extension: z.string().nullable(),
					}),
					z.object({ kind: z.literal("blocked"), reason: z.string() }),
				]),
			}),
		),
	}),
	ToolErrorSchema,
]);
export const AttachmentOutputSchema = z.union([
	IdentitySchema.extend({
		status: z.literal("raw"),
		mimeType: z.string(),
		resourceUri: z.string(),
		clientSupport: z.enum(["declared", "unverified"]),
		guidance: z.string(),
	}),
	ToolErrorSchema,
]);
