import { htmlToText } from "html-to-text";
import type { FetchMessageObject, ListResponse } from "imapflow";
import { ImapFlow } from "imapflow";
import { type ParsedMail, simpleParser } from "mailparser";
import type { GetThreadInput, SearchMessagesInput } from "../mcp/schemas.js";
import type { BridgeConfig } from "./config.js";
import { buildSearchQuery } from "./search.js";
import {
	mailboxSummary,
	messageSummary,
	parsedAddressText,
} from "./serializers.js";

type MessageLookupInput = { mailbox: string; uid: number };
type ThreadLookupInput = GetThreadInput & { mailboxes: string[] };

const THREAD_HEADER_FIELDS = ["Message-ID", "References", "In-Reply-To"];

type ThreadMessageSummary = ReturnType<typeof messageSummary> & {
	mailbox: string;
	messageId?: string;
	inReplyTo?: string;
	references: string[];
	threadKey?: string;
};

function messageReceivedTime(message: FetchMessageObject) {
	const date = message.internalDate ?? message.envelope?.date;

	if (date instanceof Date) {
		return date.getTime();
	}

	if (typeof date === "string" || typeof date === "number") {
		const timestamp = new Date(date).getTime();
		return Number.isFinite(timestamp) ? timestamp : 0;
	}

	return 0;
}

function normalizeMessageId(value: string | undefined) {
	return value?.trim().replace(/^<|>$/g, "").toLowerCase();
}

function parseMessageIds(value: string | string[] | undefined) {
	const values = Array.isArray(value) ? value : value ? [value] : [];
	const ids: string[] = [];

	for (const item of values) {
		const matches = item.match(/<[^<>]+>/g);

		if (matches) {
			ids.push(...matches);
			continue;
		}

		if (item.trim()) {
			ids.push(item.trim());
		}
	}

	return [...new Set(ids)];
}

function messageIdentity(message: ThreadMessageSummary) {
	const messageId = normalizeMessageId(message.messageId);
	return messageId
		? `message-id:${messageId}`
		: `${message.mailbox}:${message.uid}`;
}

function threadKeyFor(message: ThreadMessageSummary) {
	const [rootReference] = message.references;
	return (
		normalizeMessageId(rootReference) ?? normalizeMessageId(message.messageId)
	);
}

function relatedMessageIds(message: ThreadMessageSummary) {
	return [message.messageId, message.inReplyTo, ...message.references]
		.map(normalizeMessageId)
		.filter((value): value is string => Boolean(value));
}

function fallbackHtmlText(html: string | false | undefined) {
	if (typeof html !== "string") {
		return "";
	}

	return htmlToText(html, {
		wordwrap: false,
		selectors: [{ selector: "img", format: "skip" }],
	}).trim();
}

function parsedPlainText(parsed: ParsedMail | undefined) {
	const text = parsed?.text?.trim();

	if (text) {
		return parsed?.text ?? "";
	}

	return fallbackHtmlText(parsed?.html);
}

async function parseThreadHeaders(message: FetchMessageObject) {
	const parsed = message.headers
		? await simpleParser(message.headers, { skipHtmlToText: true })
		: undefined;

	return {
		messageId: parsed?.messageId ?? message.envelope?.messageId,
		inReplyTo: parsed?.inReplyTo ?? message.envelope?.inReplyTo,
		references: parseMessageIds(parsed?.references),
	};
}

async function threadMessageSummary(
	mailbox: string,
	message: FetchMessageObject,
): Promise<ThreadMessageSummary> {
	const headers = await parseThreadHeaders(message);
	const summary = {
		...messageSummary(message),
		mailbox,
		...headers,
		references: headers.references,
	};

	return {
		...summary,
		threadKey: threadKeyFor(summary),
	};
}

function createImapClient(config: BridgeConfig): ImapFlow {
	return new ImapFlow({
		host: config.host,
		port: config.imapPort,
		secure: false,
		auth: {
			user: config.user,
			pass: config.password,
		},
		tls: {
			rejectUnauthorized: config.tlsRejectUnauthorized,
		},
		doSTARTTLS: true,
		logger: false,
	});
}

async function withImap<T>(
	config: BridgeConfig,
	operation: (client: ImapFlow) => Promise<T>,
): Promise<T> {
	const client = createImapClient(config);
	await client.connect();

	try {
		return await operation(client);
	} finally {
		await client.logout().catch(() => {
			client.close();
		});
	}
}

async function listMailboxes(config: BridgeConfig) {
	const mailboxes = await withImap(config, async (client) => {
		return client.list({
			statusQuery: {
				messages: true,
				unseen: true,
				uidNext: true,
			},
		});
	});

	return mailboxes.map((mailbox: ListResponse) => mailboxSummary(mailbox));
}

async function searchMessages(
	config: BridgeConfig,
	input: SearchMessagesInput,
) {
	return withImap(config, async (client) => {
		await client.mailboxOpen(input.mailbox, { readOnly: true });

		const searchResult = await client.search(buildSearchQuery(input), {
			uid: true,
		});

		if (!searchResult || searchResult.length === 0) {
			return [];
		}

		const fetched = await client.fetchAll(
			searchResult,
			{
				uid: true,
				envelope: true,
				flags: true,
				internalDate: true,
				size: true,
			},
			{ uid: true },
		);

		// UID is mailbox insert order, doesn't necessarily reflect mail date
		// Sort on internalDate to get mmost recent
		return fetched
			.sort(
				(a: FetchMessageObject, b: FetchMessageObject) =>
					messageReceivedTime(b) - messageReceivedTime(a) ||
					(b.uid ?? 0) - (a.uid ?? 0),
			)
			.slice(0, input.limit)
			.map((message: FetchMessageObject) => messageSummary(message));
	});
}

async function getMessage(config: BridgeConfig, input: MessageLookupInput) {
	return withImap(config, async (client) => {
		await client.mailboxOpen(input.mailbox, { readOnly: true });
		const fetched = await client.fetchOne(
			String(input.uid),
			{
				uid: true,
				envelope: true,
				flags: true,
				internalDate: true,
				size: true,
				source: true,
			},
			{ uid: true },
		);

		if (!fetched) {
			return null;
		}

		const parsed = fetched.source
			? await simpleParser(fetched.source, { skipHtmlToText: true })
			: undefined;

		return {
			...messageSummary(fetched),
			messageId: parsed?.messageId ?? fetched.envelope?.messageId,
			headers: {
				from: parsedAddressText(parsed?.from),
				to: parsedAddressText(parsed?.to),
				cc: parsedAddressText(parsed?.cc),
				replyTo: parsedAddressText(parsed?.replyTo),
				date: parsed?.date?.toISOString(),
				inReplyTo: parsed?.inReplyTo ?? fetched.envelope?.inReplyTo,
				references: parseMessageIds(parsed?.references),
			},
			text: parsedPlainText(parsed),
		};
	});
}

async function getMessageSummary(
	config: BridgeConfig,
	input: MessageLookupInput,
) {
	return withImap(config, async (client) => {
		await client.mailboxOpen(input.mailbox, { readOnly: true });
		const fetched = await client.fetchOne(
			String(input.uid),
			{
				uid: true,
				envelope: true,
				flags: true,
				internalDate: true,
				size: true,
			},
			{ uid: true },
		);

		return fetched ? messageSummary(fetched) : null;
	});
}

async function fetchThreadMessages(
	client: ImapFlow,
	mailbox: string,
	uids: number[],
) {
	if (uids.length === 0) {
		return [];
	}

	const fetched = await client.fetchAll(
		uids,
		{
			uid: true,
			envelope: true,
			flags: true,
			internalDate: true,
			size: true,
			headers: THREAD_HEADER_FIELDS,
		},
		{ uid: true },
	);

	const messages: ThreadMessageSummary[] = [];

	for (const message of fetched) {
		messages.push(await threadMessageSummary(mailbox, message));
	}

	return messages;
}

function addThreadMessage(
	messages: Map<string, ThreadMessageSummary>,
	message: ThreadMessageSummary,
) {
	const key = messageIdentity(message);

	if (messages.has(key)) {
		return false;
	}

	messages.set(key, message);
	return true;
}

async function searchHeader(client: ImapFlow, header: string, value: string) {
	const result = await client.search(
		{
			header: {
				[header]: value,
			},
		},
		{ uid: true },
	);

	return result || [];
}

async function findRelatedUids(client: ImapFlow, id: string) {
	const messageIds = await searchHeader(client, "Message-ID", id);
	const references = await searchHeader(client, "References", id);
	const replies = await searchHeader(client, "In-Reply-To", id);

	return [...new Set([...messageIds, ...references, ...replies])];
}

async function getThread(config: BridgeConfig, input: ThreadLookupInput) {
	return withImap(config, async (client) => {
		const messages = new Map<string, ThreadMessageSummary>();
		const searchedIds = new Set<string>();
		const mailboxes = [...new Set([input.mailbox, ...input.mailboxes])];

		await client.mailboxOpen(input.mailbox, { readOnly: true });
		const [anchor] = await fetchThreadMessages(client, input.mailbox, [
			input.uid,
		]);

		if (!anchor) {
			return null;
		}

		addThreadMessage(messages, anchor);

		while (messages.size < input.limit) {
			const idsToSearch = [...messages.values()]
				.flatMap(relatedMessageIds)
				.filter((id) => !searchedIds.has(id));

			if (idsToSearch.length === 0) {
				break;
			}

			let foundNewMessage = false;

			for (const id of idsToSearch) {
				searchedIds.add(id);

				for (const mailbox of mailboxes) {
					await client.mailboxOpen(mailbox, { readOnly: true });
					const relatedUids = await findRelatedUids(client, id);
					const unfetchedUids = relatedUids.filter(
						(uid) =>
							![...messages.values()].some(
								(message) => message.mailbox === mailbox && message.uid === uid,
							),
					);

					for (const message of await fetchThreadMessages(
						client,
						mailbox,
						unfetchedUids,
					)) {
						if (messages.size >= input.limit) {
							break;
						}

						foundNewMessage =
							addThreadMessage(messages, message) || foundNewMessage;
					}
				}
			}

			if (!foundNewMessage) {
				break;
			}
		}

		const sortedMessages = [...messages.values()].sort(
			(a, b) =>
				new Date(a.date ?? 0).getTime() - new Date(b.date ?? 0).getTime() ||
				(a.uid ?? 0) - (b.uid ?? 0),
		);

		return {
			threadKey: threadKeyFor(anchor),
			anchor,
			messages: sortedMessages,
		};
	});
}

export function createImapService(config: BridgeConfig) {
	return {
		listMailboxes: () => listMailboxes(config),
		searchMessages: (input: SearchMessagesInput) =>
			searchMessages(config, input),
		getMessage: (input: MessageLookupInput) => getMessage(config, input),
		getMessageSummary: (input: MessageLookupInput) =>
			getMessageSummary(config, input),
		getThread: (input: ThreadLookupInput) => getThread(config, input),
	};
}
