import type { ManageMessageInput } from "@/mail/inbox/model.js";
import type { MessageSummary } from "@/mail/message.js";
import { MailError } from "@/shared/mail-error.js";
import type { ReadPolicy } from "./schema.js";

export const READ_POLICY_NOT_CONFIGURED =
	"Read policy is not configured. Ask the user to run `protonmail-mcp setup` in a terminal so they can choose which mailboxes and senders this MCP server may read.";

type AccountReadPolicy = Exclude<ReadPolicy, { version: 1 }>;

type AccountGrants = Pick<
	AccountReadPolicy,
	| "allowedAttachmentExtensions"
	| "requireAttachmentApproval"
	| "inboxWrites"
	| "mailboxCreation"
> & { bridgeUser: string | undefined };

function accountGrants(policy: ReadPolicy): AccountGrants {
	if (policy.version === 1)
		return {
			bridgeUser: undefined,
			allowedAttachmentExtensions: [],
			requireAttachmentApproval: false,
			inboxWrites: { mode: "disabled" },
			mailboxCreation: [],
		};

	return {
		bridgeUser: policy.bridgeUser,
		allowedAttachmentExtensions: policy.allowedAttachmentExtensions,
		requireAttachmentApproval: policy.requireAttachmentApproval,
		inboxWrites: policy.inboxWrites,
		mailboxCreation: policy.mailboxCreation,
	};
}

export function summarizeReadPolicy(policy: ReadPolicy) {
	const grants = accountGrants(policy);
	return {
		policyFileConfigured: true,
		requiresSetup: policy.version !== 3,
		version: policy.version,
		bridgeUser: grants.bridgeUser,
		allowedTools: policy.version === 3 ? policy.allowedTools : [],
		allowedMailboxes: policy.allowedMailboxes,
		allowedSenderEmails: policy.allowedSenderEmails,
		allowedSenderDomains: policy.allowedSenderDomains,
		allowedAttachmentExtensions: grants.allowedAttachmentExtensions,
		requireAttachmentApproval: grants.requireAttachmentApproval,
		inboxWrites: grants.inboxWrites,
		mailboxCreation: grants.mailboxCreation,
		createdAt: policy.createdAt,
		updatedAt: policy.updatedAt,
	};
}

export function canReadMailbox(policy: ReadPolicy, mailbox: string) {
	return policy.allowedMailboxes.includes(mailbox);
}

export function requireInboxWrite(
	policy: ReadPolicy,
	input: ManageMessageInput,
	destination?: string,
) {
	if (
		policy.version === 1 ||
		policy.inboxWrites.mode !== "enabled" ||
		!policy.inboxWrites.actions.includes(input.change.action)
	)
		throw new MailError(
			"POLICY_DENIED",
			"This inbox action is disabled by the local policy. Run protonmail-mcp setup to grant inbox write permissions.",
			"configure",
		);

	const writableMailboxes = policy.inboxWrites.mailboxes;
	const affectedMailboxes =
		destination === undefined ? [input.mailbox] : [input.mailbox, destination];
	for (const mailbox of affectedMailboxes) {
		if (
			!canReadMailbox(policy, mailbox) ||
			!writableMailboxes.includes(mailbox)
		)
			throw new MailError(
				"POLICY_DENIED",
				`Mailbox ${mailbox} needs both read and inbox write permission.`,
				"configure",
			);
	}
}

export function readPolicyStatus(
	policy: ReadPolicy | null,
	bridgeUser: string,
) {
	if (!policy) return "not_configured";
	if (policy.version !== 3) return "legacy_policy";
	return policy.bridgeUser === bridgeUser ? "ok" : "account_mismatch";
}

function senderDomain(email: string) {
	return email.includes("@") ? email.split("@").at(-1) : undefined;
}

function isAllowedSender(policy: ReadPolicy, email: string) {
	if (policy.allowedSenderEmails.includes(email)) return true;
	const domain = senderDomain(email);
	return domain ? policy.allowedSenderDomains.includes(domain) : false;
}

export function canReadMessage(
	policy: ReadPolicy,
	input: { mailbox: string; message: MessageSummary },
) {
	if (!canReadMailbox(policy, input.mailbox)) return false;

	const restrictsSenders =
		policy.allowedSenderEmails.length > 0 ||
		policy.allowedSenderDomains.length > 0;
	if (!restrictsSenders) return true;

	return input.message.senderEmails.some((email) =>
		isAllowedSender(policy, email),
	);
}
