import type { AttachmentExtension } from "../attachments/formats.js";
import { createDraftService } from "../drafts/service.js";
import type { DraftStore } from "../drafts/store.js";
import { createInboxService } from "../inbox/service.js";
import type { InboxStore } from "../inbox/store.js";
import { mediaManifest } from "../outgoing/media.js";
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
import type { CreateDraftLookupInput, EditDraftLookupInput } from "./drafts.js";
import { findMessageCopies } from "./message-copies.js";
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
import { mailboxSummary, parsedAddressEmails } from "./serializers.js";
import { createImapSession } from "./session.js";
import { getThread, type ThreadLookupInput } from "./threads.js";

export function createImapService(
	config: BridgeConfig,
	run = createImapSession(config),
	draftStore?: DraftStore,
	inboxStore?: InboxStore,
) {
	const drafts = createDraftService(config, run, draftStore);
	return {
		inbox: createInboxService(config, run, inboxStore),
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
		createDraft: (input: CreateDraftLookupInput, request?: object) =>
			drafts.create(input, allowAllMessages, request),
		editDraft: (
			input: EditDraftLookupInput,
			accepts: MessageFilter = allowAllMessages,
		) => drafts.edit(input, accepts),
		getDraftOperation: drafts.get,
		existingDraftOperation: drafts.existing,
		listDraftOperations: drafts.list,
		reconcileDraftOperation: drafts.reconcile,
		retryDraftCleanup: drafts.retryCleanup,
		getDraft: (input: GetMessageInput, accepts: MessageFilter) =>
			run(async (client) => {
				const { original, fingerprint, media } = await inspectDraft(
					client,
					input,
					accepts,
				);
				return {
					...input,
					revision: fingerprint,
					from: original.from?.text ?? "",
					to: parsedAddressEmails(original.to),
					cc: parsedAddressEmails(original.cc),
					bcc: parsedAddressEmails(original.bcc),
					subject: original.subject ?? "",
					text: original.text ?? "",
					media: mediaManifest(media),
				};
			}),
		getDraftSnapshot: (input: GetMessageInput, accepts: MessageFilter) =>
			run((client) => readDraftSnapshot(client, config, input, accepts)),
		deleteDraftSnapshot: (
			input: GetMessageInput,
			fingerprint: string,
			accepts: MessageFilter,
		): Promise<DraftCleanup> =>
			run(async (client) => {
				let current: Awaited<ReturnType<typeof inspectDraft>>;
				try {
					current = await inspectDraft(client, input, accepts);
				} catch (error) {
					if (error instanceof MailError && error.code === "NOT_FOUND")
						return { status: "deleted" };
					throw error;
				}
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
		) =>
			run((client) => findMessageCopies(client, mailbox, messageId, accepts)),
		getThread: (
			input: ThreadLookupInput,
			accepts: MessageFilter = allowAllMessages,
		) => run((client) => getThread(client, input, accepts)),
	};
}

export type ImapService = ReturnType<typeof createImapService>;
