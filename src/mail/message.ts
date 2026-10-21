import { z } from "zod";
import { GetMessageSchema } from "./identity.js";

export function withinMessageReadLimit(size: number | undefined) {
	return (
		size !== undefined &&
		Number.isSafeInteger(size) &&
		size >= 0 &&
		size <= 10 * 1024 * 1024
	);
}

export const MessageSummarySchema = z.object({
	uid: GetMessageSchema.shape.uid,
	uidValidity: GetMessageSchema.shape.uidValidity,
	subject: z.string(),
	from: z.array(z.string()),
	senderEmails: z.array(z.string()),
	to: z.array(z.string()),
	cc: z.array(z.string()),
	date: z.iso.datetime().optional(),
	flags: z.array(z.string()),
	size: z.number().optional(),
});
export const MessageBodySchema = MessageSummarySchema.extend({
	messageId: z.string().optional(),
	headers: z.object({
		from: z.string().optional(),
		to: z.string().optional(),
		cc: z.string().optional(),
		bcc: z.string().optional(),
		replyTo: z.string().optional(),
		date: z.iso.datetime().optional(),
		inReplyTo: z.string().optional(),
		references: z.array(z.string()),
	}),
	addresses: z.object({
		from: z.array(z.string()),
		to: z.array(z.string()),
		cc: z.array(z.string()),
		replyTo: z.array(z.string()),
	}),
	text: z.string(),
});

export type MessageSummary = z.infer<typeof MessageSummarySchema>;
export type MessageContent = z.infer<typeof MessageBodySchema>;
