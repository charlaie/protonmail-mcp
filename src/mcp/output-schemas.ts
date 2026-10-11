import { z } from "zod";
import {
	MessageBodySchema,
	MessageSummarySchema,
} from "../bridge/message-model.js";
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

export const CreateDraftOutputSchema = z.union([
	z.object({
		status: z.literal("created"),
		mailbox: z.string(),
		uid: z.number().optional(),
		uidValidity: z.string().optional(),
		seq: z.number().optional(),
		messageId: z.string(),
	}),
	ToolErrorSchema,
]);
const ReplacementFields = {
	mailbox: z.string(),
	oldUid: z.number(),
	newUid: z.number().optional(),
	newUidValidity: z.string().optional(),
	newSeq: z.number().optional(),
	messageId: z.string(),
};
export const EditDraftOutputSchema = z.union([
	z.object({ status: z.literal("updated"), ...ReplacementFields }),
	z.object({
		status: z.literal("replacement_created_old_delete_failed"),
		...ReplacementFields,
		reason: z.string(),
		retry: z.literal("reconcile"),
	}),
	z.object({
		status: z.enum([
			"blocked_uidplus_required",
			"blocked_unsupported_draft",
			"not_found",
		]),
		mailbox: z.string(),
		oldUid: z.number(),
		reason: z.string(),
		retry: RetrySchema,
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
export const SendOutputSchema = z.union([
	SendOperationSchema.omit({ requestHash: true }).extend({
		retry: RetrySchema,
	}),
	ToolErrorSchema,
]);
