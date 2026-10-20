import type { MailWriteAuthorization } from "../bridge/authorization.js";
import type { ReadResult } from "../bridge/imap/reading/messages.js";
import type {
	GetThreadInput,
	SearchMessagesInput,
} from "../bridge/imap/reading/requests.js";
import type { ImapService } from "../bridge/imap/service.js";
import { requireToolPermission } from "../policy/access.js";
import {
	canReadMailbox,
	canReadMessage,
	READ_POLICY_NOT_CONFIGURED,
	requireInboxWrite,
} from "../policy/enforcement.js";
import { loadReadPolicy } from "../policy/store.js";
import type { ToolName } from "../policy/tools.js";
import { hashContent } from "../shared/content-hash.js";
import { MailError } from "../shared/mail-error.js";
import type { AttachmentMetadata } from "./attachments/incoming.js";
import type { GetAttachmentInput } from "./attachments/requests.js";
import type { EditDraftRequest, GetDraftInput } from "./drafts/requests.js";
import type { GetMessageInput } from "./identity.js";
import type { CreateMailboxInput } from "./inbox/creation.js";
import type { ManageMessageInput } from "./inbox/model.js";
import type { MessageSummary } from "./message.js";

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

async function requireReadPolicy(bridgeUser: string, policyFile?: string) {
	const policy = await loadReadPolicy(policyFile);
	if (!policy)
		throw new MailError(
			"POLICY_NOT_CONFIGURED",
			READ_POLICY_NOT_CONFIGURED,
			"configure",
		);
	if (policy.version !== 3 || policy.bridgeUser !== bridgeUser)
		throw new MailError(
			"ACCOUNT_MISMATCH",
			"Read policy is not bound to this Bridge account. Run protonmail-mcp setup for this account to configure its access.",
			"configure",
		);
	return policy;
}

export async function createMailAccess(
	imap: ImapService,
	bridgeUser: string,
	policyFile?: string,
) {
	const policy = await requireReadPolicy(bridgeUser, policyFile);
	const attachmentOptions = {
		allowedExtensions: policy.allowedAttachmentExtensions,
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
	async function resolveDraftReference(
		input: GetDraftInput,
		draftsMailbox?: string,
	) {
		const identity = await imap.drafts.resolveReference(input, draftsMailbox);
		requireMailbox(identity.mailbox);
		return identity;
	}
	function authorizeMailWrite(
		tool: ToolName,
		requiredReads: { mailbox: string; message: MessageSummary }[] = [],
	): MailWriteAuthorization {
		return async (mailbox, messages = []) => {
			const current = await requireReadPolicy(bridgeUser, policyFile);
			requireToolPermission(current, bridgeUser, tool);
			if (
				!canReadMailbox(current, mailbox) ||
				[
					...requiredReads,
					...messages.map((message) => ({ mailbox, message })),
				].some((read) => !canReadMessage(current, read))
			)
				throw new MailError(
					"POLICY_DENIED",
					"Current mailbox or sender permissions deny this mail change.",
					"configure",
				);
		};
	}
	return {
		resolveDraftReference,
		async createMailbox(input: CreateMailboxInput) {
			return imap.createMailbox(input, async () => {
				const current = await requireReadPolicy(bridgeUser, policyFile);
				requireToolPermission(current, bridgeUser, "create_mailbox");
				if (!current.mailboxCreation.includes(input.kind))
					throw new MailError(
						"POLICY_DENIED",
						`Creation of ${input.kind} mailboxes is disabled. Run setup to grant creation permission.`,
						"configure",
					);
			});
		},
		authorizeMailWrite,
		async getInboxCapabilities() {
			const capabilities = await imap.inbox.capabilities();
			const writePolicy = policy.inboxWrites;
			return {
				nativeMoveSupported: capabilities.nativeMoveSupported,
				writePolicy,
				mailboxes: capabilities.mailboxes
					.filter((mailbox) => canReadMailbox(policy, mailbox.path))
					.map((mailbox) => ({
						...mailbox,
						writable:
							mailbox.kind !== "drafts" &&
							writePolicy.mode === "enabled" &&
							writePolicy.mailboxes.includes(mailbox.path),
					})),
			};
		},
		async manageInbox(input: ManageMessageInput) {
			return imap.inbox.manage(input, async (destination) => {
				const currentPolicy = await requireReadPolicy(bridgeUser, policyFile);
				requireToolPermission(currentPolicy, bridgeUser, "manage_message");
				requireInboxWrite(currentPolicy, input, destination);
				return (mailbox, message) =>
					canReadMessage(currentPolicy, { mailbox, message });
			});
		},
		async reconcileInboxOperation(operationId: string) {
			const record = await imap.inbox.get(operationId);
			return imap.inbox.reconcile(operationId, async (destination) => {
				const currentPolicy = await requireReadPolicy(bridgeUser, policyFile);
				requireToolPermission(
					currentPolicy,
					bridgeUser,
					"reconcile_inbox_operation",
				);
				for (const mailbox of destination
					? [record.request.mailbox, destination]
					: [record.request.mailbox]) {
					if (!canReadMailbox(currentPolicy, mailbox))
						throw new MailError(
							"POLICY_DENIED",
							`Mailbox ${mailbox} needs read permission for reconciliation.`,
							"configure",
						);
				}
				return (mailbox, message) =>
					canReadMessage(currentPolicy, { mailbox, message });
			});
		},
		async getDraft(input: GetDraftInput) {
			return imap.drafts.read(await resolveDraftReference(input), accepts);
		},
		async editDraft(request: EditDraftRequest) {
			return imap.drafts.edit({
				request,
				mailbox: await requireSpecialMailbox("\\Drafts", "Drafts"),
				accepts,
				authorize: authorizeMailWrite("edit_draft"),
			});
		},
		async reconcileDraftOperation(operationId: string) {
			const record = await imap.drafts.get(operationId);
			requireMailbox(record.mailbox);
			return imap.drafts.reconcile(operationId, accepts);
		},
		async retryDraftCleanup(operationId: string) {
			const record = await imap.drafts.get(operationId);
			requireMailbox(record.mailbox);
			return imap.drafts.retryCleanup(
				operationId,
				accepts,
				authorizeMailWrite("retry_draft_cleanup"),
			);
		},
		async getDraftSnapshot(input: GetMessageInput) {
			requireMailbox(input.mailbox);
			return imap.drafts.snapshot(input, accepts);
		},
		async deleteDraftSnapshot(
			input: GetMessageInput,
			fingerprint: string,
			tool: "send_draft" | "retry_send_cleanup" = "send_draft",
		) {
			requireMailbox(input.mailbox);
			return imap.drafts.deleteSnapshot(
				input,
				fingerprint,
				accepts,
				authorizeMailWrite(tool),
			);
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
			return policy.requireAttachmentApproval
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
				(policy.requireAttachmentApproval && authorization?.kind !== "human") ||
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

export type MailAccess = Awaited<ReturnType<typeof createMailAccess>>;
