import { z } from "zod";
import {
	type AttachmentPermission,
	AttachmentPermissionSchema,
} from "@/mail/attachments/formats.js";
import { MailboxCreationKindSchema } from "@/mail/inbox/creation.js";
import {
	type InboxWritePolicy,
	InboxWritePolicySchema,
} from "@/mail/inbox/model.js";
import { READ_ONLY_TOOLS, type ToolName, ToolNameSchema } from "./tools.js";

export const DomainSchema = z
	.string()
	.min(1)
	.regex(
		/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i,
		"Expected a domain like example.com.",
	)
	.transform((value) => value.toLowerCase());

function inboxWritesAreReadable(policy: {
	allowedMailboxes: string[];
	inboxWrites: InboxWritePolicy;
}) {
	if (policy.inboxWrites.mode === "disabled") return true;
	return policy.inboxWrites.mailboxes.every((mailbox) =>
		policy.allowedMailboxes.includes(mailbox),
	);
}

const InboxWritesReadableIssue = {
	path: ["inboxWrites", "mailboxes"],
	message: "Inbox writable mailboxes must also be allowed for reading.",
};

export const ReadPolicySchema = z
	.strictObject({
		version: z.literal(3),
		bridgeUser: z.string().min(1),
		allowedTools: z.array(ToolNameSchema),
		allowedMailboxes: z.array(z.string().min(1)).min(1),
		allowedSenderEmails: z.array(
			z.email().transform((value) => value.toLowerCase()),
		),
		allowedSenderDomains: z.array(DomainSchema),
		allowedAttachmentExtensions: z.array(AttachmentPermissionSchema),
		requireAttachmentApproval: z.boolean(),
		inboxWrites: InboxWritePolicySchema,
		mailboxCreation: z.array(MailboxCreationKindSchema),
		createdAt: z.iso.datetime(),
		updatedAt: z.iso.datetime(),
	})
	.refine(inboxWritesAreReadable, InboxWritesReadableIssue);

export type ReadPolicy = z.infer<typeof ReadPolicySchema>;

type ReadPolicyInput = {
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
};

function unique<T>(values: readonly T[]) {
	return [...new Set(values)];
}

function normalizedAddresses(values: readonly string[] = []) {
	return unique(values.map((value) => value.trim().toLowerCase()));
}

export function createReadPolicy(input: ReadPolicyInput) {
	const now = new Date().toISOString();

	return ReadPolicySchema.parse({
		version: 3,
		allowedTools: unique(input.allowedTools ?? READ_ONLY_TOOLS),
		bridgeUser: input.bridgeUser,
		inboxWrites: input.inboxWrites ?? { mode: "disabled" },
		mailboxCreation: input.mailboxCreation ?? [],
		requireAttachmentApproval: input.requireAttachmentApproval ?? false,
		allowedAttachmentExtensions: unique(
			input.allowedAttachmentExtensions ?? [],
		),
		allowedMailboxes: unique(
			input.allowedMailboxes.map((mailbox) => mailbox.trim()),
		),
		allowedSenderEmails: normalizedAddresses(input.allowedSenderEmails),
		allowedSenderDomains: normalizedAddresses(input.allowedSenderDomains),
		createdAt: input.createdAt ?? now,
		updatedAt: now,
	});
}
