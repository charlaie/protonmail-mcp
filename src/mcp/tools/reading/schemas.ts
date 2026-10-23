import { z } from "zod";
import { MessageBodySchema, MessageSummarySchema } from "@/mail/message.js";
import { ToolErrorSchema } from "@/shared/mail-error.js";

export const GetMessageOutputSchema = z.union([
	MessageBodySchema,
	ToolErrorSchema,
]);
export const SearchOutputSchema = z.union([
	z.object({
		status: z.literal("ok"),
		messages: z.array(MessageSummarySchema),
	}),
	ToolErrorSchema,
]);
const MailboxSchema = z.object({
	path: z.string(),
	name: z.string(),
	parentPath: z.string().optional(),
	delimiter: z.string(),
	specialUse: z.string().optional(),
	flags: z.array(z.string()),
	status: z
		.object({
			messages: z.number().optional(),
			unseen: z.number().optional(),
			uidNext: z.number().optional(),
			path: z.string().optional(),
		})
		.passthrough()
		.optional(),
	selectable: z.boolean(),
	allowedByReadPolicy: z.boolean(),
	policyStatus: z.enum(["ok", "not_configured", "account_mismatch"]),
});
export const MailboxesOutputSchema = z.union([
	z.object({ mailboxes: z.array(MailboxSchema) }),
	ToolErrorSchema,
]);

const ThreadSummarySchema = MessageSummarySchema.extend({
	bridgeInternalId: z.string().optional(),
	bridgeExternalId: z.string().optional(),
	mailbox: z.string(),
	messageId: z.string().optional(),
	references: z.array(z.string()),
	inReplyTo: z.string().optional(),
	threadKey: z.string().optional(),
});
export const ThreadOutputSchema = z.union([
	z.object({
		status: z.literal("ok"),
		reconstruction: z.literal("best_effort_message_headers"),
		threadKey: z.string().optional(),
		limitReached: z.boolean(),
		messages: z.array(
			z.union([
				ThreadSummarySchema.extend({ bodyStatus: z.literal("not_requested") }),
				ThreadSummarySchema.extend({
					bodyStatus: z.literal("unavailable"),
					reason: z.string(),
				}),
				ThreadSummarySchema.extend(MessageBodySchema.shape).extend({
					bodyStatus: z.literal("included"),
				}),
			]),
		),
	}),
	ToolErrorSchema,
]);
