import type { AttachmentExtension } from "../attachments/formats.js";
import type { DraftCleanup } from "../sending/model.js";
import { MailError } from "../shared/mail-error.js";
import {
	type AttachmentReadOptions,
	getAttachment,
	getAttachmentMetadata,
	listAttachments,
} from "./attachments.js";
import type { BridgeConfig } from "./config.js";
import { inspectDraft, readDraftSnapshot } from "./draft-content.js";
import { withDraftEdit } from "./draft-lock.js";
import {
	type CreateDraftLookupInput,
	createDraft,
	type EditDraftLookupInput,
	editDraft,
} from "./drafts.js";
import {
	allowAllMessages,
	type MessageFilter,
	readMessage,
	searchMessages,
} from "./messages.js";
import type {
	GetAttachmentInput,
	GetMessageInput,
	SearchMessagesInput,
} from "./schemas.js";
import { findSentCopies } from "./sent.js";
import { mailboxSummary } from "./serializers.js";
import { createImapSession } from "./session.js";
import { getThread, type ThreadLookupInput } from "./threads.js";

export function createImapService(
	config: BridgeConfig,
	run = createImapSession(config),
) {
	return {
		listMailboxes: () =>
			run(async (client) =>
				(
					await client.list({
						statusQuery: { messages: true, unseen: true, uidNext: true },
					})
				).map(mailboxSummary),
			),
		searchMessages: (
			input: SearchMessagesInput,
			accepts: MessageFilter = allowAllMessages,
		) => run((client) => searchMessages(client, input, accepts)),
		getMessage: (
			input: GetMessageInput,
			accepts: MessageFilter = allowAllMessages,
		) => run((client) => readMessage(client, input, accepts)),
		listAttachments: (
			input: GetMessageInput,
			accepts: MessageFilter,
			allowed: AttachmentExtension[],
		) => run((client) => listAttachments(client, input, accepts, allowed)),
		getAttachment: (
			input: GetAttachmentInput,
			accepts: MessageFilter,
			options: AttachmentReadOptions,
		) => run((client) => getAttachment(client, input, accepts, options)),
		getAttachmentMetadata: (
			input: GetAttachmentInput,
			accepts: MessageFilter,
			allowed: AttachmentExtension[],
		) =>
			run((client) => getAttachmentMetadata(client, input, accepts, allowed)),
		createDraft: (input: CreateDraftLookupInput) =>
			run((client) => createDraft(client, config, input)),
		editDraft: (input: EditDraftLookupInput) =>
			withDraftEdit(config, input, () =>
				run((client) => editDraft(client, config, input)),
			),
		getDraftSnapshot: (input: GetMessageInput, accepts: MessageFilter) =>
			run((client) => readDraftSnapshot(client, config, input, accepts)),
		deleteDraftSnapshot: (
			input: GetMessageInput,
			fingerprint: string,
			accepts: MessageFilter,
		): Promise<DraftCleanup> =>
			run(async (client) => {
				const current = await inspectDraft(client, input, accepts);
				if (current.fingerprint !== fingerprint)
					return {
						status: "retained",
						reason:
							"Draft changed after approval. It was retained; email acceptance is already recorded. Do not resend.",
					};
				if (!client.capabilities.has("UIDPLUS"))
					return {
						status: "retained",
						reason:
							"UIDPLUS is unavailable. Delete the sent draft in Proton Mail; do not resend.",
					};
				if (!(await client.messageDelete(input.uid, { uid: true })))
					throw new MailError(
						"OPERATION_FAILED",
						"Draft deletion was not confirmed.",
						"reconcile",
					);
				return { status: "deleted" };
			}),
		findSentCopies: (
			mailbox: string,
			messageId: string,
			accepts: MessageFilter,
		) => run((client) => findSentCopies(client, mailbox, messageId, accepts)),
		getThread: (
			input: ThreadLookupInput,
			accepts: MessageFilter = allowAllMessages,
		) => run((client) => getThread(client, input, accepts)),
	};
}

export type ImapService = ReturnType<typeof createImapService>;
