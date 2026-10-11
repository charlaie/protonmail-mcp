import { htmlToText } from "html-to-text";
import type { FetchMessageObject } from "imapflow";
import { simpleParser } from "mailparser";
import { MailError } from "../shared/mail-error.js";
import type { MessageContent } from "./message-model.js";
import type { GetMessageInput, SearchMessagesInput } from "./schemas.js";
import { buildSearchQuery } from "./search.js";
import {
	type MessageSummary,
	messageReceivedTime,
	messageSummary,
	parsedAddressEmails,
	parsedAddressText,
	validDate,
} from "./serializers.js";
import type { ImapClient } from "./session.js";

export type MessageFilter = (
	mailbox: string,
	message: MessageSummary,
) => boolean;
export type ReadResult<T> =
	| { kind: "found"; value: T }
	| { kind: "not_found" }
	| { kind: "denied" }
	| { kind: "unavailable"; reason: string };
export const allowAllMessages: MessageFilter = () => true;
export const SUMMARY_FIELDS = {
	uid: true,
	envelope: true,
	flags: true,
	internalDate: true,
	size: true,
};
export const FETCH_BATCH_SIZE = 200;
const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;

export function checkUidValidity(expected: string | undefined, actual: bigint) {
	if (expected !== undefined && expected !== actual.toString())
		throw new MailError(
			"STALE_IDENTITY",
			"Mailbox UIDVALIDITY changed. Search again for the current message UID before retrying.",
			"refresh_identity",
		);
}

export function parseMessageIds(value: string | string[] | undefined) {
	const values = Array.isArray(value) ? value : value ? [value] : [];
	return [
		...new Set(
			values.flatMap(
				(item) => item.match(/<[^<>]+>/g) ?? (item.trim() ? [item.trim()] : []),
			),
		),
	];
}

export async function searchMessages(
	client: ImapClient,
	input: SearchMessagesInput,
	accepts: MessageFilter,
) {
	const mailbox = await client.mailboxOpen(input.mailbox, { readOnly: true });
	const uids = await client.search(buildSearchQuery(input), { uid: true });
	if (uids === false)
		throw new Error(
			"Proton Bridge could not complete the message search. Try again.",
		);
	let newest: FetchMessageObject[] = [];
	for (let offset = 0; offset < uids.length; offset += FETCH_BATCH_SIZE) {
		const batch = await client.fetchAll(
			uids.slice(offset, offset + FETCH_BATCH_SIZE),
			SUMMARY_FIELDS,
			{ uid: true },
		);
		newest = [
			...newest,
			...batch.filter((message) =>
				accepts(
					input.mailbox,
					messageSummary(message, mailbox.uidValidity.toString()),
				),
			),
		]
			.sort(
				(a, b) =>
					messageReceivedTime(b) - messageReceivedTime(a) || b.uid - a.uid,
			)
			.slice(0, input.limit);
	}
	return newest.map((message) =>
		messageSummary(message, mailbox.uidValidity.toString()),
	);
}

export async function readMessage(
	client: ImapClient,
	input: GetMessageInput,
	accepts: MessageFilter,
): Promise<ReadResult<MessageContent>> {
	const mailbox = await client.mailboxOpen(input.mailbox, { readOnly: true });
	checkUidValidity(input.uidValidity, mailbox.uidValidity);
	const summary = await client.fetchOne(String(input.uid), SUMMARY_FIELDS, {
		uid: true,
	});
	if (!summary) return { kind: "not_found" } as const;
	if (
		!accepts(
			input.mailbox,
			messageSummary(summary, mailbox.uidValidity.toString()),
		)
	)
		return { kind: "denied" } as const;
	if (summary.size === undefined || summary.size > MAX_MESSAGE_BYTES)
		return {
			kind: "unavailable",
			reason:
				"Message content exceeds the 10 MiB read limit or its size is unavailable. Read it in Proton Mail instead.",
		} as const;
	const fetched = await client.fetchOne(
		String(input.uid),
		{ ...SUMMARY_FIELDS, source: true },
		{ uid: true },
	);
	if (!fetched) return { kind: "not_found" } as const;
	if (
		!accepts(
			input.mailbox,
			messageSummary(fetched, mailbox.uidValidity.toString()),
		)
	)
		return { kind: "denied" } as const;
	if (!fetched.source)
		throw new Error(
			`Proton Bridge returned no content for message UID ${input.uid}.`,
		);
	const parsed = await simpleParser(fetched.source, {
		skipHtmlToText: true,
		skipTextToHtml: true,
	});
	const text = parsed.text?.trim()
		? parsed.text
		: typeof parsed.html === "string"
			? htmlToText(parsed.html, {
					wordwrap: false,
					selectors: [{ selector: "img", format: "skip" }],
				}).trim()
			: "";
	return {
		kind: "found",
		value: {
			...messageSummary(fetched, mailbox.uidValidity.toString()),
			subject: parsed.subject ?? fetched.envelope?.subject ?? "",
			messageId: parsed.messageId ?? fetched.envelope?.messageId,
			headers: {
				from: parsedAddressText(parsed.from),
				to: parsedAddressText(parsed.to),
				cc: parsedAddressText(parsed.cc),
				bcc: parsedAddressText(parsed.bcc),
				replyTo: parsedAddressText(parsed.replyTo),
				date: validDate(parsed.date)?.toISOString(),
				inReplyTo: parsed.inReplyTo ?? fetched.envelope?.inReplyTo,
				references: parseMessageIds(parsed.references),
			},
			addresses: {
				from: parsedAddressEmails(parsed.from),
				to: parsedAddressEmails(parsed.to),
				cc: parsedAddressEmails(parsed.cc),
				replyTo: parsedAddressEmails(parsed.replyTo),
			},
			text,
		},
	} as const;
}
