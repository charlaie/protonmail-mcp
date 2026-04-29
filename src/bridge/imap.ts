import { ImapFlow } from "imapflow";
import type { FetchMessageObject, ListResponse } from "imapflow";
import { simpleParser } from "mailparser";

import type { BridgeConfig } from "./config.js";
import { buildSearchQuery } from "./search.js";
import {
	mailboxSummary,
	messageSummary,
	parsedAddressText,
} from "./serializers.js";
import type { SearchMessagesInput } from "../mcp/schemas.js";

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

export async function listMailboxes(config: BridgeConfig) {
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

export async function searchMessages(
	config: BridgeConfig,
	input: SearchMessagesInput,
) {
	return withImap(config, async (client) => {
		await client.mailboxOpen(input.mailbox, { readOnly: true });

		const searchResult = await client.search(buildSearchQuery(input), {
			uid: true,
		});

		if (!searchResult) {
			return [];
		}

		const uids = searchResult.slice(-input.limit).reverse();
		const fetched = await client.fetchAll(
			uids,
			{
				uid: true,
				envelope: true,
				flags: true,
				internalDate: true,
				size: true,
			},
			{ uid: true },
		);

		const byUid = new Map(
			fetched.map((message: FetchMessageObject) => [message.uid, message]),
		);

		return uids.flatMap((uid) => {
			const message = byUid.get(uid);
			return message ? [messageSummary(message)] : [];
		});
	});
}

export async function getMessage(
	config: BridgeConfig,
	input: { mailbox: string; uid: number },
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
