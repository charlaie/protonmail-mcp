import { type ParsedMail, simpleParser } from "mailparser";
import { mediaManifest } from "../outgoing/media.js";
import { parsedMedia } from "../outgoing/mime.js";
import { hashContent, OutgoingMessageSchema } from "../sending/model.js";
import { MailError } from "../shared/mail-error.js";
import type { BridgeConfig } from "./config.js";
import {
	allowAllMessages,
	checkUidValidity,
	type MessageFilter,
	parseMessageIds,
	SUMMARY_FIELDS,
} from "./messages.js";
import type { GetMessageInput } from "./schemas.js";
import {
	messageSummary,
	parsedAddressEmails,
	parsedAddressText,
} from "./serializers.js";
import type { ImapClient } from "./session.js";

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

export async function inspectDraft(
	client: ImapClient,
	input: GetMessageInput,
	accepts: MessageFilter = allowAllMessages,
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
		summary.size === undefined ||
		summary.size > 10 * 1024 * 1024 ||
		!summary.flags?.has("\\Draft") ||
		summary.flags.has("\\Deleted")
	)
		throw new MailError(
			"UNSUPPORTED_CONTENT",
			"Draft is oversized, lacks a known size or Draft flag, or is marked for deletion. Inspect it in Proton Mail.",
			"never",
		);
	const full = await client.fetchOne(
		input.uid,
		{ uid: true, source: true },
		{ uid: true },
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
	if (full.source.length > 10 * 1024 * 1024)
		throw new MailError(
			"UNSUPPORTED_CONTENT",
			"Draft exceeds the 10 MiB read limit.",
			"never",
		);
	const original = await simpleParser(full.source, {
		skipHtmlToText: true,
		skipTextToHtml: true,
		skipImageLinks: true,
	});
	let media: ReturnType<typeof parsedMedia>;
	try {
		media = parsedMedia(original);
	} catch (error) {
		if (error instanceof MailError) throw error;
		throw new MailError(
			"UNSUPPORTED_CONTENT",
			"Draft attachments or inline images exceed limits or have unsupported metadata. Edit it in Proton Mail.",
			"never",
			{ cause: error },
		);
	}

	if (
		!accepts(input.mailbox, {
			...messageSummary(summary, input.uidValidity),
			senderEmails: parsedAddressEmails(original.from).map((address) =>
				address.toLowerCase(),
			),
		})
	)
		throw new MailError(
			"POLICY_DENIED",
			"Fetched draft sender is not allowed by the read policy.",
			"configure",
		);
	return {
		original,
		media,
		fingerprint: hashContent(full.source.toString("base64")),
	};
}

export async function readDraftSnapshot(
	client: ImapClient,
	config: BridgeConfig,
	input: GetMessageInput,
	accepts: MessageFilter,
) {
	const { original, fingerprint, media } = await inspectDraft(
		client,
		input,
		accepts,
	);
	const from = parsedAddressEmails(original.from);
	if (from.length !== 1 || !config.ownAddresses.includes(from[0].toLowerCase()))
		throw new MailError(
			"UNSUPPORTED_CONTENT",
			"Draft sender must be one of this account's configured own addresses. Configure PROTONMAIL_BRIDGE_OWN_ADDRESSES for aliases.",
			"configure",
		);
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
		message: message.data,
		draftMessageId: original.messageId,
	};
}
