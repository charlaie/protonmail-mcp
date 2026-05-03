import type { FetchMessageObject, ListResponse } from "imapflow";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { SearchMessagesInput } from "../mcp/schemas.js";
import type { BridgeConfig } from "./config.js";
import { buildSearchQuery } from "./search.js";
import {
	mailboxSummary,
	messageSummary,
	parsedAddressText,
} from "./serializers.js";

type MessageLookupInput = { mailbox: string; uid: number };

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
			},
			text: parsed?.text ?? "",
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

export function createImapService(config: BridgeConfig) {
	return {
		listMailboxes: () => listMailboxes(config),
		searchMessages: (input: SearchMessagesInput) =>
			searchMessages(config, input),
		getMessage: (input: MessageLookupInput) => getMessage(config, input),
		getMessageSummary: (input: MessageLookupInput) =>
			getMessageSummary(config, input),
	};
}
