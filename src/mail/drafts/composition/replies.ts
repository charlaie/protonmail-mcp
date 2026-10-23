import type { z } from "zod";
import type { BridgeConfig } from "@/bridge/config.js";
import {
	parseMessageIds,
	type readMessage,
} from "@/bridge/imap/reading/messages.js";
import type { CreateReplyDraftSchema } from "@/mail/drafts/requests.js";
import { outgoingMedia } from "@/mail/outgoing/media/model.js";
import { OutgoingMessageSchema } from "@/mail/outgoing/message.js";
import { resolveSender } from "@/mail/outgoing/senders.js";
import { MailError } from "@/shared/mail-error.js";
import type { CreateDraftLookupInput } from "./compose.js";

type Message = Extract<
	Awaited<ReturnType<typeof readMessage>>,
	{ kind: "found" }
>["value"];

/** Removes own addresses and case-insensitive duplicates, keeping first occurrences. */
function otherParticipants(addresses: string[], own: Set<string>) {
	const seen = new Set(own);
	return addresses.filter((address) => {
		const key = address.toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function replyRecipients(original: Message, own: Set<string>) {
	const { addresses } = original;
	const to = otherParticipants(
		addresses.replyTo.length ? addresses.replyTo : addresses.from,
		own,
	);
	const sentByOwnAddress = addresses.from.some((address) =>
		own.has(address.toLowerCase()),
	);
	// Replying to an outgoing message follows up with its original recipients.
	if (!to.length && sentByOwnAddress)
		return otherParticipants(addresses.to, own);
	return to;
}

function replyAllCc(original: Message, own: Set<string>, to: string[]) {
	const primary = new Set(to.map((recipient) => recipient.toLowerCase()));
	return otherParticipants(
		[...original.addresses.to, ...original.addresses.cc],
		own,
	).filter((address) => !primary.has(address.toLowerCase()));
}

function replySender(
	config: BridgeConfig,
	original: Message,
	own: Set<string>,
	requested: string | undefined,
) {
	const addressedOwn = [
		...original.addresses.to,
		...original.addresses.cc,
	].find((address) => own.has(address.toLowerCase()));
	return resolveSender(config, requested ?? addressedOwn);
}

function inheritedReferences(original: Message) {
	if (original.headers.references.length) return original.headers.references;
	const inReplyTo = parseMessageIds(original.headers.inReplyTo);
	return inReplyTo.length === 1 ? inReplyTo : [];
}

function replySubject(subject: string) {
	return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

export function composeReplyDraft(
	config: BridgeConfig,
	original: Message,
	input: z.infer<typeof CreateReplyDraftSchema>,
	mailbox: string,
): CreateDraftLookupInput {
	const own = new Set(config.ownAddresses);
	const to = replyRecipients(original, own);
	const cc = input.replyAll ? replyAllCc(original, own, to) : [];
	const from = replySender(config, original, own, input.from);
	const parent = parseMessageIds(original.messageId);

	const message = OutgoingMessageSchema.safeParse({
		from,
		to,
		cc,
		bcc: [],
		subject: replySubject(original.subject),
		text: input.text,
		media: outgoingMedia(input),
		inReplyTo: parent,
		references: [...new Set([...inheritedReferences(original), ...parent])],
	});
	if (!message.success)
		throw new MailError(
			"UNSUPPORTED_CONTENT",
			"Cannot derive a valid reply from this message's recipients or threading headers. Compose it in Proton Mail.",
			"never",
		);
	return {
		operationId: input.operationId,
		attachments: input.attachments,
		inlineImages: input.inlineImages,
		mailbox,
		from,
		to,
		...(cc.length ? { cc } : {}),
		subject: message.data.subject,
		text: message.data.text,
		inReplyTo: message.data.inReplyTo,
		references: message.data.references,
	};
}
