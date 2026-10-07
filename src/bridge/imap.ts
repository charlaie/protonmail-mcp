import type { BridgeConfig } from "./config.js";
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
import type { GetMessageInput, SearchMessagesInput } from "./schemas.js";
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
		createDraft: (input: CreateDraftLookupInput) =>
			run((client) => createDraft(client, config, input)),
		editDraft: (input: EditDraftLookupInput) =>
			run((client) => editDraft(client, config, input)),
		getThread: (
			input: ThreadLookupInput,
			accepts: MessageFilter = allowAllMessages,
		) => run((client) => getThread(client, input, accepts)),
	};
}

export type ImapService = ReturnType<typeof createImapService>;
