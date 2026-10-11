import { simpleParser } from "mailparser";
import { MailError } from "../shared/mail-error.js";
import {
	FETCH_BATCH_SIZE,
	type MessageFilter,
	SUMMARY_FIELDS,
} from "./messages.js";
import { messageSummary } from "./serializers.js";
import type { ImapClient } from "./session.js";

export async function findSentCopies(
	client: ImapClient,
	mailbox: string,
	messageId: string,
	accepts: MessageFilter,
) {
	const selected = await client.mailboxOpen(mailbox, { readOnly: true });
	const uids = await client.search(
		{ header: { "Message-ID": messageId } },
		{ uid: true },
	);
	if (uids === false)
		throw new MailError(
			"CONNECTION_FAILED",
			"Could not search Sent. The send remains uncertain.",
			"safe",
		);
	if (uids.length > 1000)
		throw new MailError(
			"OPERATION_FAILED",
			"Sent reconciliation found too many candidates. Inspect Sent manually; the send remains uncertain.",
			"reconcile",
		);
	const matches: { mailbox: string; uid: number; uidValidity: string }[] = [];
	for (let offset = 0; offset < uids.length; offset += FETCH_BATCH_SIZE) {
		const batch = await client.fetchAll(
			uids.slice(offset, offset + FETCH_BATCH_SIZE),
			{ ...SUMMARY_FIELDS, headers: ["Message-ID"] },
			{ uid: true },
		);
		for (const message of batch) {
			if (
				!accepts(
					mailbox,
					messageSummary(message, selected.uidValidity.toString()),
				)
			)
				continue;
			const parsed = message.headers
				? await simpleParser(message.headers)
				: undefined;
			if ((parsed?.messageId ?? message.envelope?.messageId) === messageId)
				matches.push({
					mailbox,
					uid: message.uid,
					uidValidity: selected.uidValidity.toString(),
				});
		}
	}
	return matches;
}
