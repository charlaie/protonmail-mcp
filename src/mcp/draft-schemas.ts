import { z } from "zod";
import { DraftOperationSchema } from "../drafts/model.js";
import { DraftIdSchema } from "../drafts/requests.js";
import { GetMessageSchema } from "../mail/identity.js";
import { MediaMetadataSchema } from "../outgoing/media.js";
import { RetrySchema, ToolErrorSchema } from "../shared/mail-error.js";

export const DraftRecordOutputSchema = DraftOperationSchema.omit({
	requestHash: true,
}).extend({ retry: RetrySchema });
export const DraftOperationOutputSchema = z.union([
	DraftRecordOutputSchema,
	ToolErrorSchema,
]);
export const ListDraftOperationsOutputSchema = z.union([
	z.object({
		operations: z.array(DraftRecordOutputSchema),
		nextOffset: z.number().int().nullable(),
	}),
	ToolErrorSchema,
]);
export const GetDraftOutputSchema = z.union([
	GetMessageSchema.extend({
		draftId: DraftIdSchema,
		revision: z.string(),
		from: z.string(),
		to: z.array(z.string()),
		cc: z.array(z.string()),
		bcc: z.array(z.string()),
		subject: z.string(),
		text: z.string(),
		media: z.array(MediaMetadataSchema),
	}),
	ToolErrorSchema,
]);
