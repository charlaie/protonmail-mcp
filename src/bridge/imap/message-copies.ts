import { simpleParser } from "mailparser";
import {
	FETCH_BATCH_SIZE,
	type MessageFilter,
	SUMMARY_FIELDS,
} from "@/bridge/imap/reading/messages.js";
import { MailError } from "@/shared/mail-error.js";
import { messageSummary } from "./serializers.js";
import type { ImapClient } from "./session.js";

export async function findMessageCopies(
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
			"Could not search the mailbox. The operation remains uncertain.",
			"safe",
		);
	if (uids.length > 1000)
		throw new MailError(
			"OPERATION_FAILED",
			"Message-ID reconciliation found too many candidates. Inspect the mailbox manually; the operation remains uncertain.",
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
