import { z } from "zod";
import { GetMessageSchema } from "@/mail/identity.js";
import { OperationIdSchema } from "@/operations/identity.js";

export const InboxActionNameSchema = z.enum([
	"mark_read",
	"mark_unread",
	"star",
	"unstar",
	"archive",
	"trash",
	"move",
	"apply_label",
	"remove_label",
]);
export const InboxWritePolicySchema = z.discriminatedUnion("mode", [
	z.object({ mode: z.literal("disabled") }),
	z.object({
		mode: z.literal("enabled"),
		actions: z.array(InboxActionNameSchema).min(1),
		mailboxes: z.array(z.string().min(1)).min(1),
	}),
]);
export type InboxWritePolicy = z.infer<typeof InboxWritePolicySchema>;

export const InboxActionSchema = z.discriminatedUnion("action", [
	z.object({
		action: InboxActionNameSchema.extract([
			"mark_read",
			"mark_unread",
			"star",
			"unstar",
		]),
	}),
	z.object({ action: InboxActionNameSchema.extract(["archive", "trash"]) }),
	z.object({ action: z.literal("move"), destination: z.string().min(1) }),
	z.object({ action: z.literal("apply_label"), label: z.string().min(1) }),
	z.object({
		action: z.literal("remove_label"),
		destination: z.string().min(1),
	}),
]);
export const ManageMessageSchema = z.object({
	operationId: OperationIdSchema,
	...GetMessageSchema.shape,
	change: InboxActionSchema,
});
export type ManageMessageInput = z.infer<typeof ManageMessageSchema>;

export const InboxPlanSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("flag"),
		flag: z.enum(["\\Seen", "\\Flagged"]),
		enabled: z.boolean(),
		sourceMayDisappear: z.boolean(),
	}),
	z.object({
		kind: z.literal("move"),
		destination: z.string().min(1),
		retainsSource: z.boolean(),
	}),
]);
export type InboxPlan = z.infer<typeof InboxPlanSchema>;
export const InboxOperationSchema = z.object({
	operationId: OperationIdSchema,
	requestHash: z.string(),
	request: ManageMessageSchema,
	plan: InboxPlanSchema,
	messageId: z.string().nullable(),
	metadataHash: z.string(),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
	outcome: z.discriminatedUnion("status", [
		z.object({ status: z.literal("reserved") }),
		z.object({ status: z.literal("submitting") }),
		z.object({ status: z.literal("aborted"), reason: z.string() }),
		z.object({ status: z.literal("uncertain"), reason: z.string() }),
		z.object({
			status: z.literal("completed"),
			destinationIdentity: GetMessageSchema.nullable(),
		}),
	]),
});
export type InboxOperation = z.infer<typeof InboxOperationSchema>;
