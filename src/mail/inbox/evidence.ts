import type { FetchMessageObject, MailboxObject } from "imapflow";
import { findMessageCopies } from "@/bridge/imap/message-copies.js";
import {
	checkUidValidity,
	type MessageFilter,
	SUMMARY_FIELDS,
} from "@/bridge/imap/reading/messages.js";
import { messageSummary } from "@/bridge/imap/serializers.js";
import type { ImapClient } from "@/bridge/imap/session.js";
import type { GetMessageInput } from "@/mail/identity.js";
import { hashContent } from "@/shared/content-hash.js";
import { MailError } from "@/shared/mail-error.js";
import type { InboxOperation } from "./model.js";

export function metadataHash(message: FetchMessageObject, uidValidity: string) {
	const summary = messageSummary(message, uidValidity);
	return hashContent({
		messageId: message.envelope?.messageId ?? null,
		subject: summary.subject,
		from: summary.from,
		to: summary.to,
		cc: summary.cc,
		size: summary.size,
	});
}

export type InspectedMessage = {
	message: FetchMessageObject;
	selected: MailboxObject;
};

export async function inspectMessage(
	client: ImapClient,
	identity: GetMessageInput,
	accepts: MessageFilter,
): Promise<InspectedMessage | null> {
	const selected = await client.mailboxOpen(identity.mailbox);
	checkUidValidity(identity.uidValidity, selected.uidValidity);
	const message = await client.fetchOne(identity.uid, SUMMARY_FIELDS, {
		uid: true,
	});
	if (!message) return null;
	if (!accepts(identity.mailbox, messageSummary(message, identity.uidValidity)))
		throw new MailError(
			"POLICY_DENIED",
			"Message sender is not allowed by the read policy.",
			"configure",
		);
	if (
		!message.flags ||
		message.flags.has("\\Draft") ||
		message.flags.has("\\Deleted")
	)
		throw new MailError(
			"POLICY_DENIED",
			"Inbox tools cannot mutate drafts, deleted messages, or messages without known flags.",
			"never",
		);
	return { message, selected };
}

type ReconciliationEvidence =
	| { kind: "inconclusive" }
	| { kind: "completed"; destinationIdentity: GetMessageInput | null };

const INCONCLUSIVE: ReconciliationEvidence = { kind: "inconclusive" };

/** Returns the single copy in `mailbox` whose metadata matches the recorded source. */
async function findMatchingCopy(
	client: ImapClient,
	record: InboxOperation,
	mailbox: string,
	messageId: string,
	accepts: MessageFilter,
) {
	const identities = await findMessageCopies(
		client,
		mailbox,
		messageId,
		accepts,
	);
	const [identity] = identities;
	if (identities.length !== 1 || !identity) return null;

	const copy = await inspectMessage(client, identity, accepts);
	if (!copy) return null;
	return metadataHash(copy.message, identity.uidValidity) ===
		record.metadataHash
		? identity
		: null;
}

/** Observe placement and flags without ever repeating the original command. */
export async function reconcileInboxEvidence(
	client: ImapClient,
	record: InboxOperation,
	accepts: MessageFilter,
): Promise<ReconciliationEvidence> {
	const { plan, request, messageId } = record;
	const source = await inspectMessage(client, request, accepts);

	if (plan.kind === "flag") {
		const flagApplied =
			source !== null &&
			metadataHash(source.message, request.uidValidity) ===
				record.metadataHash &&
			source.message.flags?.has(plan.flag) === plan.enabled;
		return flagApplied
			? { kind: "completed", destinationIdentity: null }
			: INCONCLUSIVE;
	}

	if (!messageId) return INCONCLUSIVE;
	const target = await findMatchingCopy(
		client,
		record,
		plan.destination,
		messageId,
		accepts,
	);
	if (!target) return INCONCLUSIVE;

	if (plan.retainsSource) {
		const retained = await findMatchingCopy(
			client,
			record,
			request.mailbox,
			messageId,
			accepts,
		);
		if (!retained) return INCONCLUSIVE;
	} else if (source) {
		return INCONCLUSIVE;
	}
	return { kind: "completed", destinationIdentity: target };
}
