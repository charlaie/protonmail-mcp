import type { MessageSummary } from "../bridge/serializers.js";
import type { ReadPolicy } from "./schema.js";

export const READ_POLICY_NOT_CONFIGURED =
	"Read policy is not configured. Ask the user to run `protonmail-mcp setup` in a terminal so they can choose which mailboxes and senders this MCP server may read.";

function normalizeEmail(value: string) {
	return value.trim().toLowerCase();
}

function senderEmails(message: MessageSummary) {
	return message.from
		.map((value) => {
			// extract email from within <> if in contact format
			const match = value.match(/<([^>]+)>$/);
			return normalizeEmail(match?.[1] ?? value);
		})
		.filter(Boolean);
}

function senderDomain(email: string) {
	return email.includes("@") ? email.split("@").at(-1) : undefined;
}

export function summarizeReadPolicy(policy: ReadPolicy) {
	return {
		policyFileConfigured: true,
		version: policy.version,
		allowedMailboxes: policy.allowedMailboxes,
		allowedSenderEmails: policy.allowedSenderEmails,
		allowedSenderDomains: policy.allowedSenderDomains,
		createdAt: policy.createdAt,
		updatedAt: policy.updatedAt,
	};
}

export function canReadMailbox(policy: ReadPolicy, mailbox: string) {
	return policy.allowedMailboxes.includes(mailbox);
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

	const emails = senderEmails(input.message);
	return emails.some((email) => {
		if (policy.allowedSenderEmails.includes(email)) {
			return true;
		}

		const domain = senderDomain(email);
		return domain ? policy.allowedSenderDomains.includes(domain) : false;
	});
}

export function filterAllowedMessages<T extends MessageSummary>(
	policy: ReadPolicy,
	mailbox: string,
	messages: T[],
) {
	if (!canReadMailbox(policy, mailbox)) {
		return [];
	}

	return messages.filter((message) =>
		canReadMessage(policy, { mailbox, message }),
	);
}
