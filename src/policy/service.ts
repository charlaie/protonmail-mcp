import type { ImapService } from "../bridge/imap.js";
import type { ReadResult } from "../bridge/messages.js";
import type {
	GetAttachmentInput,
	GetMessageInput,
	GetThreadInput,
	SearchMessagesInput,
} from "../bridge/schemas.js";
import {
	canReadMailbox,
	canReadMessage,
	READ_POLICY_NOT_CONFIGURED,
	readPolicyStatus,
} from "./enforcement.js";
import { getPolicyFilePath, loadReadPolicy } from "./store.js";

async function requireReadPolicy(bridgeUser: string) {
	const policy = await loadReadPolicy();
	if (!policy) throw new Error(READ_POLICY_NOT_CONFIGURED);
	if (readPolicyStatus(policy, bridgeUser) !== "ok")
		throw new Error(
			"Read policy is not bound to this Bridge account. Run protonmail-mcp setup for this account to configure its access.",
		);
	return policy;
}

export async function createReadService(imap: ImapService, bridgeUser: string) {
	const policy = await requireReadPolicy(bridgeUser);
	const attachmentOptions = {
		allowedExtensions:
			policy.version === 2 ? policy.allowedAttachmentExtensions : [],
		protectedFiles: [getPolicyFilePath()],
	};
	function requireMailbox(mailbox: string) {
		if (!canReadMailbox(policy, mailbox))
			throw new Error(
				`Mailbox ${mailbox} is not allowed by the read policy. Run protonmail-mcp setup to change access.`,
			);
	}
	const accepts = (
		mailbox: string,
		message: Parameters<typeof canReadMessage>[1]["message"],
	) => canReadMessage(policy, { mailbox, message });
	function unwrap<T>(result: ReadResult<T>, input: GetMessageInput): T {
		switch (result.kind) {
			case "found":
				return result.value;
			case "not_found":
				throw new Error(
					`Message UID ${input.uid} was not found in mailbox ${input.mailbox}. Search again for the current UID.`,
				);
			case "denied":
				throw new Error("Message sender is not allowed by the read policy.");
			case "unavailable":
				throw new Error(result.reason);
		}
	}
	return {
		async searchMessages(input: SearchMessagesInput) {
			requireMailbox(input.mailbox);
			return imap.searchMessages(input, accepts);
		},
		async getMessage(input: GetMessageInput) {
			requireMailbox(input.mailbox);
			return unwrap(await imap.getMessage(input, accepts), input);
		},
		async listAttachments(input: GetMessageInput) {
			requireMailbox(input.mailbox);
			return unwrap(
				await imap.listAttachments(
					input,
					accepts,
					attachmentOptions.allowedExtensions,
				),
				input,
			);
		},
		async getAttachment(input: GetAttachmentInput) {
			requireMailbox(input.mailbox);
			return unwrap(
				await imap.getAttachment(input, accepts, attachmentOptions),
				input,
			);
		},
		async getThread(input: GetThreadInput) {
			requireMailbox(input.mailbox);
			const mailboxes = input.mailboxes ?? policy.allowedMailboxes;
			for (const mailbox of mailboxes) requireMailbox(mailbox);
			return unwrap(
				await imap.getThread({ ...input, mailboxes }, accepts),
				input,
			);
		},
		async requireDraftsMailbox() {
			const mailboxes = (await imap.listMailboxes()).filter(
				(mailbox) => !mailbox.flags.includes("\\Noselect"),
			);
			const drafts =
				mailboxes.find(
					(mailbox) =>
						mailbox.specialUse === "\\Drafts" ||
						mailbox.flags.includes("\\Drafts"),
				) ?? mailboxes.find((mailbox) => mailbox.path === "Drafts");
			if (!drafts)
				throw new Error(
					"Drafts mailbox was not found. Use list_mailboxes to inspect available mailboxes.",
				);
			requireMailbox(drafts.path);
			return drafts.path;
		},
	};
}
