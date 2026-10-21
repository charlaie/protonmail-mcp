import type { FetchMessageObject } from "imapflow";
import { simpleParser } from "mailparser";
import type { GetMessageInput } from "../../mail/identity.js";
import { MailError } from "../../shared/mail-error.js";
import {
	type MessageFilter,
	SUMMARY_FIELDS,
	uidBatches,
} from "./reading/messages.js";
import { messageSummary } from "./serializers.js";
import type { ImapClient } from "./session.js";

const MAX_RECONCILIATION_CANDIDATES = 1000;

// HEADER search matches substrings, so compare the parsed Message-ID exactly.
async function hasMessageId(message: FetchMessageObject, messageId: string) {
	const parsed = message.headers
		? await simpleParser(message.headers)
		: undefined;
	return (parsed?.messageId ?? message.envelope?.messageId) === messageId;
}

export async function findMessageCopies(
	client: ImapClient,
	mailbox: string,
	messageId: string,
	accepts: MessageFilter,
) {
	const selected = await client.mailboxOpen(mailbox, { readOnly: true });
	const uidValidity = selected.uidValidity.toString();
	const uids = await client.search(
		{ header: { "Message-ID": messageId } },
		{ uid: true },
	);
	if (uids === false)
		throw new MailError(
			"CONNECTION_FAILED",
			"Could not search the mailbox. The operation remains uncertain.",
			"safe",
		);
	if (uids.length > MAX_RECONCILIATION_CANDIDATES)
		throw new MailError(
			"OPERATION_FAILED",
			"Message-ID reconciliation found too many candidates. Inspect the mailbox manually; the operation remains uncertain.",
			"reconcile",
		);

	const matches: GetMessageInput[] = [];
	for (const batch of uidBatches(uids)) {
		const fetched = await client.fetchAll(
			batch,
			{ ...SUMMARY_FIELDS, headers: ["Message-ID"] },
			{ uid: true },
		);
		for (const message of fetched) {
			if (!accepts(mailbox, messageSummary(message, uidValidity))) continue;
			if (await hasMessageId(message, messageId))
				matches.push({ mailbox, uid: message.uid, uidValidity });
		}
	}
	return matches;
}
