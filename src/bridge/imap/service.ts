import type { AttachmentPermission } from "../../mail/attachments/formats.js";
import {
	type AttachmentReadOptions,
	getAttachment,
	getAttachmentMetadata,
	listAttachments,
} from "../../mail/attachments/incoming.js";
import type { GetAttachmentInput } from "../../mail/attachments/requests.js";
import { createDraftService } from "../../mail/drafts/service.js";
import type { GetMessageInput } from "../../mail/identity.js";
import {
	type CreateMailboxInput,
	createMailbox,
} from "../../mail/inbox/creation.js";
import { createInboxService } from "../../mail/inbox/service.js";
import type { DraftStore } from "../../operations/sqlite/drafts.js";
import type { InboxStore } from "../../operations/sqlite/inbox.js";
import type { BridgeConfig } from "../config.js";
import { findMessageCopies } from "./message-copies.js";
import {
	allowAllMessages,
	type MessageFilter,
	readMessage,
	searchMessages,
} from "./reading/messages.js";
import type { SearchMessagesInput } from "./reading/requests.js";
import { mailboxSummary } from "./serializers.js";
import {
	createImapSession,
	type ImapClient,
	type ImapSession,
} from "./session.js";
import { getThread, type ThreadLookupInput } from "./threads/reconstruct.js";

async function listMailboxes(client: ImapClient) {
	const mailboxes = await client.list({
		statusQuery: { messages: true, unseen: true, uidNext: true },
	});
	return mailboxes.map(mailboxSummary);
}

export function createImapService(
	config: BridgeConfig,
	dependencies: {
		run?: ImapSession;
		draftStore?: DraftStore;
		inboxStore?: InboxStore;
	} = {},
) {
	const run = dependencies.run ?? createImapSession(config);
	return {
		createMailbox: (
			input: CreateMailboxInput,
			authorize: () => Promise<void>,
		) => createMailbox(run, input, authorize),

		inbox: createInboxService(config, run, dependencies.inboxStore),

		listMailboxes: () => run(listMailboxes),

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

		drafts: createDraftService(config, run, dependencies.draftStore),

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
