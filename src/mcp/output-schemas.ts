import { z } from "zod";
import {
	MessageBodySchema,
	MessageSummarySchema,
} from "../bridge/message-model.js";
import { GetMessageSchema } from "../bridge/schemas.js";
import { DraftOperationSchema } from "../drafts/model.js";
import { MediaMetadataSchema } from "../outgoing/media.js";
import { SendOperationSchema } from "../sending/model.js";
import { RetrySchema, ToolErrorSchema } from "../shared/mail-error.js";

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
	policyStatus: z.enum([
		"ok",
		"not_configured",
		"legacy_policy",
		"account_mismatch",
	]),
});
export const MailboxesOutputSchema = z.union([
	z.object({ mailboxes: z.array(MailboxSchema) }),
	ToolErrorSchema,
]);

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
const ThreadSummarySchema = MessageSummarySchema.extend({
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
export const SendRecordOutputSchema = SendOperationSchema.omit({
	requestHash: true,
}).extend({ retry: RetrySchema });
export const SendOutputSchema = z.union([
	SendRecordOutputSchema,
	ToolErrorSchema,
]);
export const ListSendOperationsOutputSchema = z.union([
	z.object({
		operations: z.array(SendRecordOutputSchema),
		nextOffset: z.number().int().nullable(),
	}),
	ToolErrorSchema,
]);
