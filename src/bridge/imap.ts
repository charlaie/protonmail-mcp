import type { AttachmentPermission } from "../attachments/formats.js";
import {
	type AttachmentReadOptions,
	getAttachment,
	getAttachmentMetadata,
	listAttachments,
} from "../attachments/incoming.js";
import type { GetAttachmentInput } from "../attachments/requests.js";
import { createDraftService } from "../drafts/service.js";
import { type CreateMailboxInput, createMailbox } from "../inbox/creation.js";
import { createInboxService } from "../inbox/service.js";
import type { GetMessageInput } from "../mail/identity.js";
import type { DraftStore } from "../operations/drafts.js";
import type { InboxStore } from "../operations/inbox.js";
import type { BridgeConfig } from "./config.js";
import { findMessageCopies } from "./message-copies.js";
import {
	allowAllMessages,
	type MessageFilter,
	readMessage,
	searchMessages,
} from "./messages.js";
import type { SearchMessagesInput } from "./requests.js";
import { mailboxSummary } from "./serializers.js";
import { createImapSession } from "./session.js";
import { getThread, type ThreadLookupInput } from "./threads.js";

export function createImapService(
	config: BridgeConfig,
	run = createImapSession(config),
	draftStore?: DraftStore,
	inboxStore?: InboxStore,
) {
	return {
		createMailbox: (
			input: CreateMailboxInput,
			authorize: () => Promise<void>,
		) => createMailbox(run, input, authorize),
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
			allowed: AttachmentPermission[],
		) => run((client) => listAttachments(client, input, accepts, allowed)),
		getAttachment: (
			input: GetAttachmentInput,
			accepts: MessageFilter,
			options: AttachmentReadOptions,
		) => run((client) => getAttachment(client, input, accepts, options)),
		getAttachmentMetadata: (
			input: GetAttachmentInput,
			accepts: MessageFilter,
			allowed: AttachmentPermission[],
		) =>
			run((client) => getAttachmentMetadata(client, input, accepts, allowed)),
		drafts: createDraftService(config, run, draftStore),
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
