import { z } from "zod";
import { GetMessageSchema, SendEmailSchema } from "../bridge/schemas.js";
import { MediaMetadataSchema } from "../outgoing/media.js";

export const DraftSourceSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("create") }),
	GetMessageSchema.extend({ kind: z.literal("edit"), revision: z.string() }),
]);
export const DraftOperationSchema = z.object({
	operationId: SendEmailSchema.shape.operationId,
	requestHash: z.string(),
	messageId: z.string(),
	mailbox: z.string(),
	contentHash: z.string(),
	media: z.array(MediaMetadataSchema).optional(),
	source: DraftSourceSchema,
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
	outcome: z.discriminatedUnion("status", [
		z.object({ status: z.literal("appending") }),
		z.object({ status: z.literal("rejected"), reason: z.string() }),
		z.object({
			status: z.literal("saved"),
			identity: GetMessageSchema,
			revision: z.string(),
		}),
		z.object({
			status: z.literal("completed"),
			identity: GetMessageSchema,
			revision: z.string(),
		}),
		z.object({
			status: z.literal("cleanup_failed"),
			identity: GetMessageSchema,
			revision: z.string(),
			reason: z.string(),
		}),
	]),
});
export type DraftOperation = z.infer<typeof DraftOperationSchema>;
