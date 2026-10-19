import { z } from "zod";
import { MailboxCreationKindSchema } from "../inbox/creation.js";
import {
	InboxOperationSchema,
	InboxWritePolicySchema,
} from "../inbox/model.js";
import { RetrySchema, ToolErrorSchema } from "../shared/mail-error.js";

export const InboxRecordOutputSchema = InboxOperationSchema.omit({
	requestHash: true,
}).extend({ retry: RetrySchema });
export const InboxOperationOutputSchema = z.union([
	InboxRecordOutputSchema,
	ToolErrorSchema,
]);
export const InboxOperationsOutputSchema = z.union([
	z.object({
		operations: z.array(InboxRecordOutputSchema),
		nextOffset: z.number().int().nullable(),
	}),
	ToolErrorSchema,
]);
export const InboxCapabilitiesOutputSchema = z.union([
	z.object({
		nativeMoveSupported: z.boolean(),
		writePolicy: InboxWritePolicySchema,
		mailboxes: z.array(
			z.object({
				path: z.string(),
				kind: z.enum(["folder", "label", "drafts", "view"]),
				writable: z.boolean(),
			}),
		),
	}),
	ToolErrorSchema,
]);

export const CreateMailboxOutputSchema = z.union([
	z.object({
		status: z.literal("available"),
		kind: MailboxCreationKindSchema,
		path: z.string(),
	}),
	ToolErrorSchema,
]);
