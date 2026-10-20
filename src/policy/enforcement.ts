import type { ManageMessageInput } from "../mail/inbox/model.js";
import type { MessageSummary } from "../mail/message.js";
import { MailError } from "../shared/mail-error.js";
import type { ReadPolicy } from "./schema.js";

export const READ_POLICY_NOT_CONFIGURED =
	"Read policy is not configured. Ask the user to run `protonmail-mcp setup` in a terminal so they can choose which mailboxes and senders this MCP server may read.";

function senderDomain(email: string) {
	return email.includes("@") ? email.split("@").at(-1) : undefined;
}

export function summarizeReadPolicy(policy: ReadPolicy) {
	return {
		policyFileConfigured: true,
		requiresSetup: policy.version !== 3,
		version: policy.version,
		bridgeUser: policy.version !== 1 ? policy.bridgeUser : undefined,
		allowedTools: policy.version === 3 ? policy.allowedTools : [],
		allowedMailboxes: policy.allowedMailboxes,
		allowedSenderEmails: policy.allowedSenderEmails,
		allowedSenderDomains: policy.allowedSenderDomains,
		allowedAttachmentExtensions:
			policy.version !== 1 ? policy.allowedAttachmentExtensions : [],
		requireAttachmentApproval:
			policy.version !== 1 && policy.requireAttachmentApproval,
		inboxWrites:
			policy.version !== 1 ? policy.inboxWrites : { mode: "disabled" },
		mailboxCreation: policy.version !== 1 ? policy.mailboxCreation : [],
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
	for (const path of destination === undefined
		? [input.mailbox]
		: [input.mailbox, destination]) {
		if (
			!canReadMailbox(policy, path) ||
			!policy.inboxWrites.mailboxes.includes(path)
		)
			throw new MailError(
				"POLICY_DENIED",
				`Mailbox ${path} needs both read and inbox write permission.`,
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

export function canReadMessage(
	policy: ReadPolicy,
	input: { mailbox: string; message: MessageSummary },
) {
	if (!canReadMailbox(policy, input.mailbox)) {
		return false;
	}

	if (
		policy.allowedSenderEmails.length === 0 &&
		policy.allowedSenderDomains.length === 0
	) {
		return true;
	}

	const emails = input.message.senderEmails;
	return emails.some((email) => {
		if (policy.allowedSenderEmails.includes(email)) {
			return true;
		}

		const domain = senderDomain(email);
		return domain ? policy.allowedSenderDomains.includes(domain) : false;
	});
}
