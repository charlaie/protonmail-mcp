import type { MessageSummary } from "../bridge/serializers.js";
import type { ReadPolicy } from "./schema.js";

export const READ_POLICY_NOT_CONFIGURED =
	"Read policy is not configured. Ask the user to run `protonmail-mcp setup` in a terminal so they can choose which mailboxes and senders this MCP server may read.";

function senderDomain(email: string) {
	return email.includes("@") ? email.split("@").at(-1) : undefined;
}

export function summarizeReadPolicy(policy: ReadPolicy) {
	return {
		policyFileConfigured: true,
		requiresSetup: policy.version === 1,
		version: policy.version,
		bridgeUser: policy.version === 2 ? policy.bridgeUser : undefined,
		allowedMailboxes: policy.allowedMailboxes,
		allowedSenderEmails: policy.allowedSenderEmails,
		allowedSenderDomains: policy.allowedSenderDomains,
		allowedAttachmentExtensions:
			policy.version === 2 ? policy.allowedAttachmentExtensions : [],
		requireAttachmentApproval:
			policy.version === 2 && policy.requireAttachmentApproval,
		createdAt: policy.createdAt,
		updatedAt: policy.updatedAt,
	};
}

export function canReadMailbox(policy: ReadPolicy, mailbox: string) {
	return policy.allowedMailboxes.includes(mailbox);
}

export function readPolicyStatus(
	policy: ReadPolicy | null,
	bridgeUser: string,
) {
	if (!policy) return "not_configured";
	if (policy.version === 1) return "legacy_policy";
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
