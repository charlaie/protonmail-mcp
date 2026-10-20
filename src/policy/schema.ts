import { z } from "zod";
import {
	type AttachmentPermission,
	AttachmentPermissionSchema,
} from "../mail/attachments/formats.js";
import { MailboxCreationKindSchema } from "../mail/inbox/creation.js";
import {
	type InboxWritePolicy,
	InboxWritePolicySchema,
} from "../mail/inbox/model.js";
import { READ_ONLY_TOOLS, type ToolName, ToolNameSchema } from "./tools.js";

export const DomainSchema = z
	.string()
	.min(1)
	.regex(
		/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i,
		"Expected a domain like example.com.",
	)
	.transform((value) => value.toLowerCase());

const PolicyFields = {
	allowedMailboxes: z.array(z.string().min(1)).min(1),
	allowedSenderEmails: z.array(
		z.email().transform((value) => value.toLowerCase()),
	),
	allowedSenderDomains: z.array(DomainSchema),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
};

const AccountReadPolicyFields = {
	...PolicyFields,
	bridgeUser: z.string().min(1),
	allowedAttachmentExtensions: z.array(AttachmentPermissionSchema).default([]),
	requireAttachmentApproval: z.boolean().default(false),
	inboxWrites: InboxWritePolicySchema.default({ mode: "disabled" }),
	mailboxCreation: z.array(MailboxCreationKindSchema).default([]),
};

const AccountReadPolicySchema = z
	.object({
		...AccountReadPolicyFields,
		version: z.literal(2),
	})
	.refine(
		(policy) =>
			policy.inboxWrites.mode === "disabled" ||
			policy.inboxWrites.mailboxes.every((mailbox) =>
				policy.allowedMailboxes.includes(mailbox),
			),
		{
			path: ["inboxWrites", "mailboxes"],
			message: "Inbox writable mailboxes must also be allowed for reading.",
		},
	);

export const GranularPolicySchema = z
	.strictObject({
		...AccountReadPolicyFields,
		version: z.literal(3),
		allowedTools: z.array(ToolNameSchema),
	})
	.refine(
		(policy) =>
			policy.inboxWrites.mode === "disabled" ||
			policy.inboxWrites.mailboxes.every((mailbox) =>
				policy.allowedMailboxes.includes(mailbox),
			),
		{
			path: ["inboxWrites", "mailboxes"],
			message: "Inbox writable mailboxes must also be allowed for reading.",
		},
	);

export const ReadPolicySchema = z.discriminatedUnion("version", [
	z.object({ ...PolicyFields, version: z.literal(1) }),
	AccountReadPolicySchema,
	GranularPolicySchema,
]);

export type ReadPolicy = z.infer<typeof ReadPolicySchema>;

export function createReadPolicy(input: {
	bridgeUser: string;
	allowedTools?: ToolName[];
	createdAt?: string;
	allowedMailboxes: string[];
	allowedSenderEmails?: string[];
	allowedSenderDomains?: string[];
	allowedAttachmentExtensions?: AttachmentPermission[];
	requireAttachmentApproval?: boolean;
	inboxWrites?: InboxWritePolicy;
	mailboxCreation?: z.infer<typeof MailboxCreationKindSchema>[];
}) {
	const now = new Date().toISOString();

	return GranularPolicySchema.parse({
		version: 3,
		allowedTools: [...new Set(input.allowedTools ?? READ_ONLY_TOOLS)],
		bridgeUser: input.bridgeUser,
		inboxWrites: input.inboxWrites,
		mailboxCreation: input.mailboxCreation,
		requireAttachmentApproval: input.requireAttachmentApproval,
		allowedAttachmentExtensions: [
			...new Set(input.allowedAttachmentExtensions ?? []),
		],
		allowedMailboxes: [
			...new Set(input.allowedMailboxes.map((value) => value.trim())),
		],
		allowedSenderEmails: [
			...new Set(
				(input.allowedSenderEmails ?? []).map((value) =>
					value.trim().toLowerCase(),
				),
			),
		],
		allowedSenderDomains: [
			...new Set(
				(input.allowedSenderDomains ?? []).map((value) =>
					value.trim().toLowerCase(),
				),
			),
		],
		createdAt: input.createdAt ?? now,
		updatedAt: now,
	});
}
