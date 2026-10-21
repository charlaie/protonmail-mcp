import { z } from "zod";

import { GetMessageSchema } from "@/mail/identity.js";

export const MAX_ATTACHMENT_ID_LENGTH = 100;

export const ATTACHMENT_ID_PATTERN = /^[1-9]\d*(?:\.[1-9]\d*)*$/;

export const ListAttachmentsSchema = GetMessageSchema;

export const GetAttachmentSchema = GetMessageSchema.extend({
	attachmentId: z
		.string()
		.max(MAX_ATTACHMENT_ID_LENGTH)
		.regex(ATTACHMENT_ID_PATTERN)
		.describe(
			"Attachment ID returned by list_attachments for this exact message. Not a filename or filesystem path.",
		),
}).strict();

export type GetAttachmentInput = z.infer<typeof GetAttachmentSchema>;
