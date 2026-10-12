import type { AttachmentMetadata } from "../bridge/attachments.js";
import type { ImapService } from "../bridge/imap.js";
import type { ReadResult } from "../bridge/messages.js";
import type {
	GetAttachmentInput,
	GetMessageInput,
	GetThreadInput,
	SearchMessagesInput,
} from "../bridge/schemas.js";
import { hashContent } from "../sending/model.js";
import { MailError } from "../shared/mail-error.js";
import {
	canReadMailbox,
	canReadMessage,
	READ_POLICY_NOT_CONFIGURED,
	readPolicyStatus,
} from "./enforcement.js";
import { loadReadPolicy } from "./store.js";

export type AttachmentApprovalInput = {
	bridgeUser: string;
	policyFingerprint: string;
	attachment: AttachmentMetadata;
};

export type AttachmentReadAuthorization =
	| { kind: "policy"; input: AttachmentApprovalInput }
	| { kind: "human"; input: AttachmentApprovalInput };

type AttachmentReadPlan =
	| { kind: "approval_required"; input: AttachmentApprovalInput }
	| {
			kind: "authorized";
			authorization: Extract<AttachmentReadAuthorization, { kind: "policy" }>;
	  };

async function requireReadPolicy(bridgeUser: string) {
	const policy = await loadReadPolicy();
	if (!policy)
		throw new MailError(
			"POLICY_NOT_CONFIGURED",
			READ_POLICY_NOT_CONFIGURED,
			"configure",
		);
	if (readPolicyStatus(policy, bridgeUser) !== "ok")
		throw new MailError(
			"ACCOUNT_MISMATCH",
			"Read policy is not bound to this Bridge account. Run protonmail-mcp setup for this account to configure its access.",
			"configure",
		);
	return policy;
}

export async function createReadService(imap: ImapService, bridgeUser: string) {
	const policy = await requireReadPolicy(bridgeUser);
	const attachmentOptions = {
		allowedExtensions:
			policy.version === 2 ? policy.allowedAttachmentExtensions : [],
	};
	function requireMailbox(mailbox: string) {
		if (!canReadMailbox(policy, mailbox))
			throw new MailError(
				"POLICY_DENIED",
				`Mailbox ${mailbox} is not allowed by the read policy. Run protonmail-mcp setup to change access.`,
				"configure",
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
				throw new MailError(
					"NOT_FOUND",
					`Message UID ${input.uid} was not found in mailbox ${input.mailbox}. Search again for the current UID.`,
					"refresh_identity",
				);
			case "denied":
				throw new MailError(
					"POLICY_DENIED",
					"Message sender is not allowed by the read policy.",
					"configure",
				);
			case "unavailable":
				throw new MailError("UNSUPPORTED_CONTENT", result.reason, "never");
		}
	}
	async function requireSpecialMailbox(specialUse: string, fallback: string) {
		const mailboxes = (await imap.listMailboxes()).filter(
			(mailbox) => !mailbox.flags.includes("\\Noselect"),
		);
		const mailbox =
			mailboxes.find(
				(item) =>
					item.specialUse === specialUse || item.flags.includes(specialUse),
			) ?? mailboxes.find((item) => item.path === fallback);
		if (!mailbox)
			throw new MailError(
				"NOT_FOUND",
				`${fallback} mailbox was not found. Use list_mailboxes to inspect available mailboxes.`,
				"configure",
			);
		requireMailbox(mailbox.path);
		return mailbox.path;
	}
	return {
		async getDraftSnapshot(input: GetMessageInput) {
			requireMailbox(input.mailbox);
			return imap.getDraftSnapshot(input, accepts);
		},
		async deleteDraftSnapshot(input: GetMessageInput, fingerprint: string) {
			requireMailbox(input.mailbox);
			return imap.deleteDraftSnapshot(input, fingerprint, accepts);
		},
		async findSentCopies(messageId: string) {
			return imap.findSentCopies(
				await requireSpecialMailbox("\\Sent", "Sent"),
				messageId,
				accepts,
			);
		},
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
		async prepareAttachmentRead(
			input: GetAttachmentInput,
		): Promise<AttachmentReadPlan> {
			requireMailbox(input.mailbox);
			const approvalInput = {
				bridgeUser,
				policyFingerprint: hashContent(policy),
				attachment: unwrap(
					await imap.getAttachmentMetadata(
						input,
						accepts,
						attachmentOptions.allowedExtensions,
					),
					input,
				),
			} satisfies AttachmentApprovalInput;
			return policy.version === 2 && policy.requireAttachmentApproval
				? { kind: "approval_required", input: approvalInput }
				: {
						kind: "authorized",
						authorization: { kind: "policy", input: approvalInput },
					};
		},
		async getAttachment(
			input: GetAttachmentInput,
			authorization?: AttachmentReadAuthorization,
		) {
			requireMailbox(input.mailbox);
			const approved = authorization?.input;
			if (
				(policy.version === 2 &&
					policy.requireAttachmentApproval &&
					authorization?.kind !== "human") ||
				(approved &&
					(approved.bridgeUser !== bridgeUser ||
						approved.policyFingerprint !== hashContent(policy)))
			)
				throw new MailError(
					"APPROVAL_DENIED",
					"Attachment not downloaded. Approval is required or the read policy changed. Review the attachment again.",
					"new_approval",
				);
			return unwrap(
				await imap.getAttachment(input, accepts, {
					...attachmentOptions,
					expectedAttachment: approved?.attachment,
				}),
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
		requireDraftsMailbox: () => requireSpecialMailbox("\\Drafts", "Drafts"),
	};
}
