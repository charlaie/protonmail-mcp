import { htmlToText } from "html-to-text";
import type { FetchMessageObject } from "imapflow";
import { type ParsedMail, simpleParser } from "mailparser";
import type { GetMessageInput } from "../../../mail/identity.js";
import {
	type MessageContent,
	type MessageSummary,
	withinMessageReadLimit,
} from "../../../mail/message.js";
import { MailError } from "../../../shared/mail-error.js";
import {
	messageReceivedTime,
	messageSummary,
	parsedAddressEmails,
	parsedAddressText,
	validDate,
} from "../serializers.js";
import type { ImapClient } from "../session.js";
import type { SearchMessagesInput } from "./requests.js";
import { buildSearchQuery } from "./search.js";

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

export function* uidBatches(uids: number[]) {
	for (let offset = 0; offset < uids.length; offset += FETCH_BATCH_SIZE) {
		yield uids.slice(offset, offset + FETCH_BATCH_SIZE);
	}
}

export function checkUidValidity(expected: string | undefined, actual: bigint) {
	if (expected === undefined || expected === actual.toString()) return;
	throw new MailError(
		"STALE_IDENTITY",
		"Mailbox UIDVALIDITY changed. Search again for the current message UID before retrying.",
		"refresh_identity",
	);
}

function messageIdsInHeader(headerValue: string) {
	const bracketed = headerValue.match(/<[^<>]+>/g);
	if (bracketed) return bracketed;
	const trimmed = headerValue.trim();
	return trimmed ? [trimmed] : [];
}

function headerValues(value: string | string[] | undefined) {
	if (Array.isArray(value)) return value;
	return value ? [value] : [];
}

export function parseMessageIds(value: string | string[] | undefined) {
	return [...new Set(headerValues(value).flatMap(messageIdsInHeader))];
}

function newestFirst(left: FetchMessageObject, right: FetchMessageObject) {
	return (
		messageReceivedTime(right) - messageReceivedTime(left) ||
		right.uid - left.uid
	);
}

export async function searchMessages(
	client: ImapClient,
	input: SearchMessagesInput,
	accepts: MessageFilter,
) {
	const mailbox = await client.mailboxOpen(input.mailbox, { readOnly: true });
	const uidValidity = mailbox.uidValidity.toString();
	const uids = await client.search(buildSearchQuery(input), { uid: true });
	if (uids === false)
		throw new Error(
			"Proton Bridge could not complete the message search. Try again.",
		);

	let newest: FetchMessageObject[] = [];
	for (const batch of uidBatches(uids)) {
		const fetched = await client.fetchAll(batch, SUMMARY_FIELDS, { uid: true });
		const accepted = fetched.filter((message) =>
			accepts(input.mailbox, messageSummary(message, uidValidity)),
		);
		newest = [...newest, ...accepted].sort(newestFirst).slice(0, input.limit);
	}
	return newest.map((message) => messageSummary(message, uidValidity));
}

function unavailable(reason: string): ReadResult<never> {
	return { kind: "unavailable", reason };
}

function plainText(parsed: ParsedMail) {
	if (parsed.text?.trim()) return parsed.text;
	if (typeof parsed.html !== "string") return "";
	return htmlToText(parsed.html, {
		wordwrap: false,
		selectors: [{ selector: "img", format: "skip" }],
	}).trim();
}

function messageContent(
	summary: MessageSummary,
	parsed: ParsedMail,
	fetched: FetchMessageObject,
): MessageContent {
	return {
		...summary,
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
		text: plainText(parsed),
	};
}

// Authorize the envelope before each fetch and the parsed sender before
// returning content.
export async function readMessage(
	client: ImapClient,
	input: GetMessageInput,
	accepts: MessageFilter,
): Promise<ReadResult<MessageContent>> {
	const mailbox = await client.mailboxOpen(input.mailbox, { readOnly: true });
	checkUidValidity(input.uidValidity, mailbox.uidValidity);
	const uidValidity = mailbox.uidValidity.toString();
	const acceptsEnvelope = (message: FetchMessageObject) =>
		accepts(input.mailbox, messageSummary(message, uidValidity));

	const summary = await client.fetchOne(String(input.uid), SUMMARY_FIELDS, {
		uid: true,
	});
	if (!summary) return { kind: "not_found" };
	if (!acceptsEnvelope(summary)) return { kind: "denied" };
	if (!withinMessageReadLimit(summary.size))
		return unavailable(
			"Message content exceeds the 10 MiB read limit or its size is unavailable. Read it in Proton Mail instead.",
		);

	const fetched = await client.fetchOne(
		String(input.uid),
		{ ...SUMMARY_FIELDS, source: true },
		{ uid: true },
	);
	if (!fetched) return { kind: "not_found" };
	if (!acceptsEnvelope(fetched)) return { kind: "denied" };
	if (!fetched.source)
		throw new Error(
			`Proton Bridge returned no content for message UID ${input.uid}.`,
		);
	if (!withinMessageReadLimit(fetched.source.length))
		return unavailable(
			"Fetched message content exceeds the 10 MiB read limit. Read it in Proton Mail instead.",
		);

	const parsed = await simpleParser(fetched.source, {
		skipHtmlToText: true,
		skipTextToHtml: true,
	});
	const parsedSummary = {
		...messageSummary(fetched, uidValidity),
		senderEmails: parsedAddressEmails(parsed.from).map((address) =>
			address.toLowerCase(),
		),
	};
	if (!accepts(input.mailbox, parsedSummary)) return { kind: "denied" };

	return {
		kind: "found",
		value: messageContent(parsedSummary, parsed, fetched),
	};
}
