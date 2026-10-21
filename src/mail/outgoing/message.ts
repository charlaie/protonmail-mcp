import { z } from "zod";

import { OutgoingMediaSchema } from "@/mail/outgoing/media/model.js";

const HeaderSchema = z
	.string()
	.max(998)
	.regex(/^[^\r\n]*$/);

export const MessageIdSchema = z
	.string()
	.max(998)
	.regex(/^<[^<>\s]+@[^<>\s]+>$/);

export const OutgoingMessageSchema = z
	.object({
		from: HeaderSchema.min(1),
		to: z.array(z.email()),
		cc: z.array(z.email()),
		bcc: z.array(z.email()),
		subject: HeaderSchema,
		text: z.string().max(100_000),
		inReplyTo: z.array(MessageIdSchema),
		references: z.array(MessageIdSchema),
		replyTo: HeaderSchema.optional(),
		media: OutgoingMediaSchema.optional(),
	})
	.refine(
		(message) => message.to.length + message.cc.length + message.bcc.length > 0,
		"At least one recipient is required.",
	);

export type OutgoingMessage = z.infer<typeof OutgoingMessageSchema>;
