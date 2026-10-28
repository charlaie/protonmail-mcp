import type { MailWriteAuthorization } from "@/bridge/authorization.js";
import type {
	MessageFilter,
	ReadResult,
} from "@/bridge/imap/reading/messages.js";
import type {
	GetThreadInput,
	SearchMessagesInput,
} from "@/bridge/imap/reading/requests.js";
import type { ImapService } from "@/bridge/imap/service.js";
import type { AttachmentMetadata } from "@/mail/attachments/incoming.js";
import type { GetAttachmentInput } from "@/mail/attachments/requests.js";
import type {
	EditDraftRequest,
	GetDraftInput,
} from "@/mail/drafts/requests.js";
import type { CreateMailboxInput } from "@/mail/inbox/creation.js";
import type { ManageMessageInput } from "@/mail/inbox/model.js";
import { requireToolPermission } from "@/policy/access.js";
import {
	canReadMailbox,
	canReadMessage,
	READ_POLICY_NOT_CONFIGURED,
	requireInboxWrite,
} from "@/policy/enforcement.js";
import type { ReadPolicy } from "@/policy/schema.js";
import { loadReadPolicy } from "@/policy/store.js";
import type { ToolName } from "@/policy/tools.js";
import { hashContent } from "@/shared/content-hash.js";
import { MailError } from "@/shared/mail-error.js";
import type { GetMessageInput } from "./identity.js";
import { findSpecialMailbox } from "./mailboxes.js";
import type { MessageSummary } from "./message.js";
import {
	type BatchGetMessagesInput,
	batchGetMessages,
} from "./reading/batch.js";

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

type MessageRead = { mailbox: string; message: MessageSummary };

async function requireReadPolicy(bridgeUser: string, policyFile?: string) {
	const policy = await loadReadPolicy(policyFile);
	if (!policy)
		throw new MailError(
			"POLICY_NOT_CONFIGURED",
			READ_POLICY_NOT_CONFIGURED,
			"configure",
		);
	if (policy.bridgeUser !== bridgeUser)
		throw new MailError(
			"ACCOUNT_MISMATCH",
			"Read policy is not bound to this Bridge account. Run protonmail-mcp setup for this account to configure its access.",
			"configure",
		);
	return policy;
}

function readFilter(policy: ReadPolicy): MessageFilter {
	return (mailbox, message) => canReadMessage(policy, { mailbox, message });
}

function unwrapReadResult<T>(result: ReadResult<T>, input: GetMessageInput): T {
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

export async function createMailAccess(
	imap: ImapService,
	bridgeUser: string,
	policyFile?: string,
) {
	const policy = await requireReadPolicy(bridgeUser, policyFile);
	const accepts = readFilter(policy);
	const allowedExtensions = policy.allowedAttachmentExtensions;

	function requireMailbox(mailbox: string) {
		if (!canReadMailbox(policy, mailbox))
			throw new MailError(
				"POLICY_DENIED",
				`Mailbox ${mailbox} is not allowed by the read policy. Run protonmail-mcp setup to change access.`,
				"configure",
			);
	}

	async function requireSpecialMailbox(role: "drafts" | "sent") {
		const mailbox = findSpecialMailbox(await imap.listMailboxes(), role);
		if (!mailbox)
			throw new MailError(
				"NOT_FOUND",
				`The ${role} mailbox was not found. Use list_mailboxes to inspect available mailboxes.`,
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

	/** Reloads the policy so each write is authorized against current grants, not the startup snapshot. */
	async function currentPolicyFor(tool: ToolName) {
		const current = await requireReadPolicy(bridgeUser, policyFile);
		requireToolPermission(current, bridgeUser, tool);
		return current;
	}

	function authorizeMailWrite(
		tool: ToolName,
		requiredReads: MessageRead[] = [],
	): MailWriteAuthorization {
		return async (mailbox, messages = []) => {
			const current = await currentPolicyFor(tool);
			const messageReads = [
				...requiredReads,
				...messages.map((message) => ({ mailbox, message })),
			];
			if (
				!canReadMailbox(current, mailbox) ||
				messageReads.some((read) => !canReadMessage(current, read))
			)
				throw new MailError(
					"POLICY_DENIED",
					"Current mailbox or sender permissions deny this mail change.",
					"configure",
				);
		};
	}

	async function createMailbox(input: CreateMailboxInput) {
		return imap.createMailbox(input, async () => {
			const current = await currentPolicyFor("create_mailbox");
			if (!current.mailboxCreation.includes(input.kind))
				throw new MailError(
					"POLICY_DENIED",
					`Creation of ${input.kind} mailboxes is disabled. Run setup to grant creation permission.`,
					"configure",
				);
		});
	}

	async function getInboxCapabilities() {
		const capabilities = await imap.inbox.capabilities();
		const writePolicy = policy.inboxWrites;
		const isWritable = (mailbox: { path: string; kind: string }) =>
			mailbox.kind !== "drafts" &&
			writePolicy.mode === "enabled" &&
			writePolicy.mailboxes.includes(mailbox.path);
		return {
			nativeMoveSupported: capabilities.nativeMoveSupported,
			writePolicy,
			mailboxes: capabilities.mailboxes
				.filter((mailbox) => canReadMailbox(policy, mailbox.path))
				.map((mailbox) => ({ ...mailbox, writable: isWritable(mailbox) })),
		};
	}

	async function manageInbox(input: ManageMessageInput) {
		return imap.inbox.manage(input, async (destination) => {
			const current = await currentPolicyFor("manage_message");
			requireInboxWrite(current, input, destination);
			return readFilter(current);
		});
	}

	async function reconcileInboxOperation(operationId: string) {
		const record = await imap.inbox.get(operationId);
		return imap.inbox.reconcile(operationId, async (destination) => {
			const current = await currentPolicyFor("reconcile_inbox_operation");
			const mailboxes = destination
				? [record.request.mailbox, destination]
				: [record.request.mailbox];
			const unreadable = mailboxes.find(
				(mailbox) => !canReadMailbox(current, mailbox),
			);
			if (unreadable !== undefined)
				throw new MailError(
					"POLICY_DENIED",
					`Mailbox ${unreadable} needs read permission for reconciliation.`,
					"configure",
				);
			return readFilter(current);
		});
	}

	async function getDraft(input: GetDraftInput) {
		return imap.drafts.read(await resolveDraftReference(input), accepts);
	}

	async function editDraft(request: EditDraftRequest) {
		return imap.drafts.edit({
			request,
			mailbox: await requireSpecialMailbox("drafts"),
			accepts,
			authorize: authorizeMailWrite("edit_draft"),
		});
	}

	async function reconcileDraftOperation(operationId: string) {
		const record = await imap.drafts.get(operationId);
		requireMailbox(record.mailbox);
		return imap.drafts.reconcile(operationId, accepts);
	}

	async function retryDraftCleanup(operationId: string) {
		const record = await imap.drafts.get(operationId);
		requireMailbox(record.mailbox);
		return imap.drafts.retryCleanup(
			operationId,
			accepts,
			authorizeMailWrite("retry_draft_cleanup"),
		);
	}

	async function getDraftSnapshot(input: GetMessageInput) {
		requireMailbox(input.mailbox);
		return imap.drafts.snapshot(input, accepts);
	}

	async function deleteDraftSnapshot(
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
	}

	async function findSentCopies(messageId: string) {
		return imap.findSentCopies(
			await requireSpecialMailbox("sent"),
			messageId,
			accepts,
		);
	}

	async function searchMessages(input: SearchMessagesInput) {
		requireMailbox(input.mailbox);
		return imap.searchMessages(input, accepts, hashContent(policy));
	}

	async function getMessage(input: GetMessageInput) {
		requireMailbox(input.mailbox);
		return unwrapReadResult(await imap.getMessage(input, accepts), input);
	}

	async function getThread(input: GetThreadInput) {
		requireMailbox(input.mailbox);
		const mailboxes = input.mailboxes ?? policy.allowedMailboxes;
		for (const mailbox of mailboxes) requireMailbox(mailbox);
		return unwrapReadResult(
			await imap.getThread({ ...input, mailboxes }, accepts),
			input,
		);
	}

	async function listAttachments(input: GetMessageInput) {
		requireMailbox(input.mailbox);
		return unwrapReadResult(
			await imap.listAttachments(input, accepts, allowedExtensions),
			input,
		);
	}

	async function prepareAttachmentRead(
		input: GetAttachmentInput,
	): Promise<AttachmentReadPlan> {
		requireMailbox(input.mailbox);
		const attachment = unwrapReadResult(
			await imap.getAttachmentMetadata(input, accepts, allowedExtensions),
			input,
		);
		const approvalInput = {
			bridgeUser,
			policyFingerprint: hashContent(policy),
			attachment,
		} satisfies AttachmentApprovalInput;
		if (policy.requireAttachmentApproval)
			return { kind: "approval_required", input: approvalInput };
		return {
			kind: "authorized",
			authorization: { kind: "policy", input: approvalInput },
		};
	}

	/** Rejects missing human approval and approvals issued for another account or policy. */
	function requireAttachmentAuthorization(
		authorization: AttachmentReadAuthorization | undefined,
	) {
		const approved = authorization?.input;
		const missingHumanApproval =
			policy.requireAttachmentApproval && authorization?.kind !== "human";
		const staleApproval =
			approved !== undefined &&
			(approved.bridgeUser !== bridgeUser ||
				approved.policyFingerprint !== hashContent(policy));
		if (missingHumanApproval || staleApproval)
			throw new MailError(
				"APPROVAL_DENIED",
				"Attachment not downloaded. Approval is required or the read policy changed. Review the attachment again.",
				"new_approval",
			);
		return approved;
	}

	async function getAttachment(
		input: GetAttachmentInput,
		authorization?: AttachmentReadAuthorization,
	) {
		requireMailbox(input.mailbox);
		const approved = requireAttachmentAuthorization(authorization);
		return unwrapReadResult(
			await imap.getAttachment(input, accepts, {
				allowedExtensions,
				expectedAttachment: approved?.attachment,
			}),
			input,
		);
	}

	return {
		resolveDraftReference,
		requireDraftsMailbox: () => requireSpecialMailbox("drafts"),
		authorizeMailWrite,
		createMailbox,
		getInboxCapabilities,
		manageInbox,
		reconcileInboxOperation,
		getDraft,
		editDraft,
		reconcileDraftOperation,
		retryDraftCleanup,
		getDraftSnapshot,
		deleteDraftSnapshot,
		findSentCopies,
		searchMessages,
		getMessage,
		batchGetMessages: (request: BatchGetMessagesInput) =>
			batchGetMessages({ request, read: getMessage }),
		getThread,
		listAttachments,
		prepareAttachmentRead,
		getAttachment,
	};
}

export type MailAccess = Awaited<ReturnType<typeof createMailAccess>>;
