import { z } from "zod";

import { GetMessageSchema } from "../identity.js";

export const ListAttachmentsSchema = GetMessageSchema;
export const GetAttachmentSchema = GetMessageSchema.extend({
	attachmentId: z
		.string()
		.max(100)
		.regex(/^[1-9]\d*(?:\.[1-9]\d*)*$/)
		.describe(
			"Attachment ID returned by list_attachments for this exact message. Not a filename or filesystem path.",
		),
}).strict();

export type GetAttachmentInput = z.infer<typeof GetAttachmentSchema>;
