import { type ParsedMail, simpleParser } from "mailparser";
import type { BridgeConfig } from "../../bridge/config.js";
import {
	checkUidValidity,
	type MessageFilter,
	parseMessageIds,
	SUMMARY_FIELDS,
} from "../../bridge/imap/reading/messages.js";
import {
	messageSummary,
	parsedAddressEmails,
	parsedAddressText,
} from "../../bridge/imap/serializers.js";
import type { ImapClient } from "../../bridge/imap/session.js";
import { hashContent } from "../../shared/content-hash.js";
import { MailError } from "../../shared/mail-error.js";
import type { GetMessageInput } from "../identity.js";
import { withinMessageReadLimit } from "../message.js";
import { parsedMedia } from "../outgoing/media/mime.js";
import { mediaManifest } from "../outgoing/media/model.js";
import { OutgoingMessageSchema } from "../outgoing/message.js";

export function draftContentHash(original: ParsedMail) {
	const media = parsedMedia(original);
	return hashContent({
		...(media.length ? { media: mediaManifest(media) } : {}),
		messageId: original.messageId,
		from: parsedAddressText(original.from),
		to: parsedAddressText(original.to),
		cc: parsedAddressText(original.cc),
		bcc: parsedAddressText(original.bcc),
		replyTo: parsedAddressText(original.replyTo),
		subject: original.subject ?? "",
		text: original.text ?? "",
		inReplyTo: parseMessageIds(original.inReplyTo),
		references: parseMessageIds(original.references),
	});
}

async function fetchDraftSummary(
	client: ImapClient,
	input: GetMessageInput,
	accepts: MessageFilter,
) {
	const mailbox = await client.mailboxOpen(input.mailbox);
	checkUidValidity(input.uidValidity, mailbox.uidValidity);
	const summary = await client.fetchOne(input.uid, SUMMARY_FIELDS, {
		uid: true,
	});
	if (!summary)
		throw new MailError(
			"NOT_FOUND",
			"Draft was not found. Search Drafts for its current identity.",
			"refresh_identity",
		);
	if (!accepts(input.mailbox, messageSummary(summary, input.uidValidity)))
		throw new MailError(
			"POLICY_DENIED",
			"Draft sender is not allowed by the read policy.",
			"configure",
		);
	if (
		!withinMessageReadLimit(summary.size) ||
		!summary.flags?.has("\\Draft") ||
		summary.flags.has("\\Deleted")
	)
		throw new MailError(
			"UNSUPPORTED_CONTENT",
			"Draft is oversized, lacks a known size or Draft flag, or is marked for deletion. Inspect it in Proton Mail.",
			"never",
		);
	return summary;
}

async function fetchDraftSource(client: ImapClient, uid: number) {
	const full = await client.fetchOne(
		uid,
		{ uid: true, source: true },
		{
			uid: true,
		},
	);
	if (full === false)
		throw new MailError(
			"NOT_FOUND",
			"Draft no longer exists. Search Drafts again.",
			"refresh_identity",
		);
	if (!full.source)
		throw new MailError(
			"OPERATION_FAILED",
			"Draft exists but its content is unavailable. Restore Bridge access before retrying cleanup.",
			"reconcile",
		);
	if (!withinMessageReadLimit(full.source.length))
		throw new MailError(
			"UNSUPPORTED_CONTENT",
			"Draft exceeds the 10 MiB read limit.",
			"never",
		);
	return full.source;
}

function draftMedia(original: ParsedMail) {
	try {
		return parsedMedia(original);
	} catch (error) {
		if (error instanceof MailError) throw error;
		throw new MailError(
			"UNSUPPORTED_CONTENT",
			"Draft attachments or inline images exceed limits or have unsupported metadata. Edit it in Proton Mail.",
			"never",
			{ cause: error },
		);
	}
}

/** Reads a draft, authorizing its envelope before the fetch and its parsed sender after. */
export async function inspectDraft(
	client: ImapClient,
	input: GetMessageInput,
	accepts: MessageFilter,
) {
	const summary = await fetchDraftSummary(client, input, accepts);
	const source = await fetchDraftSource(client, input.uid);
	const original = await simpleParser(source, {
		skipHtmlToText: true,
		skipTextToHtml: true,
		skipImageLinks: true,
	});
	const media = draftMedia(original);

	const parsedSummary = {
		...messageSummary(summary, input.uidValidity),
		senderEmails: parsedAddressEmails(original.from).map((address) =>
			address.toLowerCase(),
		),
	};
	if (!accepts(input.mailbox, parsedSummary))
		throw new MailError(
			"POLICY_DENIED",
			"Fetched draft sender is not allowed by the read policy.",
			"configure",
		);
	return {
		original,
		media,
		summary: parsedSummary,
		fingerprint: hashContent(source.toString("base64")),
	};
}

export type InspectedDraft = Awaited<ReturnType<typeof inspectDraft>>;

function requireOwnSender(config: BridgeConfig, original: ParsedMail) {
	const from = parsedAddressEmails(original.from);
	const [sender] = from;
	if (
		from.length !== 1 ||
		!sender ||
		!config.ownAddresses.includes(sender.toLowerCase())
	)
		throw new MailError(
			"UNSUPPORTED_CONTENT",
			"Draft sender must be one of this account's configured own addresses. Configure bridge.ownAddresses in the server configuration for aliases.",
			"configure",
		);
}

export async function readDraftSnapshot(
	client: ImapClient,
	config: BridgeConfig,
	input: GetMessageInput,
	accepts: MessageFilter,
) {
	const { original, fingerprint, media, summary } = await inspectDraft(
		client,
		input,
		accepts,
	);
	requireOwnSender(config, original);

	const message = OutgoingMessageSchema.safeParse({
		from: original.from?.text,
		to: parsedAddressEmails(original.to),
		cc: parsedAddressEmails(original.cc),
		bcc: parsedAddressEmails(original.bcc),
		subject: original.subject ?? "",
		text: original.text ?? "",
		...(media.length ? { media } : {}),
		inReplyTo: parseMessageIds(original.inReplyTo),
		references: parseMessageIds(original.references),
		replyTo: original.replyTo?.text,
	});
	if (!message.success)
		throw new MailError(
			"UNSUPPORTED_CONTENT",
			"Draft has invalid recipients, unsafe headers, or a body exceeding 100,000 characters. Edit it in Proton Mail.",
			"never",
		);
	return {
		fingerprint,
		summary,
		message: message.data,
		draftMessageId: original.messageId,
	};
}
