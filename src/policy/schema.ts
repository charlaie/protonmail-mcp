import { z } from "zod";
import {
	type AttachmentPermission,
	AttachmentPermissionSchema,
} from "../attachments/formats.js";
import {
	type InboxWritePolicy,
	InboxWritePolicySchema,
} from "../inbox/model.js";

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

const AccountReadPolicySchema = z
	.object({
		...PolicyFields,
		version: z.literal(2),
		bridgeUser: z.string().min(1),
		allowedAttachmentExtensions: z
			.array(AttachmentPermissionSchema)
			.default([]),
		requireAttachmentApproval: z.boolean().default(false),
		inboxWrites: InboxWritePolicySchema.default({ mode: "disabled" }),
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
]);

export type ReadPolicy = z.infer<typeof ReadPolicySchema>;

export function createReadPolicy(input: {
	bridgeUser: string;
	allowedMailboxes: string[];
	allowedSenderEmails?: string[];
	allowedSenderDomains?: string[];
	allowedAttachmentExtensions?: AttachmentPermission[];
	requireAttachmentApproval?: boolean;
	inboxWrites?: InboxWritePolicy;
}) {
	const now = new Date().toISOString();

	return AccountReadPolicySchema.parse({
		version: 2,
		bridgeUser: input.bridgeUser,
		inboxWrites: input.inboxWrites,
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
		createdAt: now,
		updatedAt: now,
	});
}
