import type { z } from "zod";
import type { BridgeConfig } from "../../../bridge/config.js";
import {
	parseMessageIds,
	type readMessage,
} from "../../../bridge/imap/reading/messages.js";
import { MailError } from "../../../shared/mail-error.js";
import { OutgoingMessageSchema } from "../../outgoing/message.js";
import { resolveSender } from "../../outgoing/senders.js";
import type { CreateReplyDraftSchema } from "../requests.js";
import type { CreateDraftLookupInput } from "./compose.js";

type Message = Extract<
	Awaited<ReturnType<typeof readMessage>>,
	{ kind: "found" }
>["value"];

export function composeReplyDraft(
	config: BridgeConfig,
	original: Message,
	input: z.infer<typeof CreateReplyDraftSchema>,
	mailbox: string,
): CreateDraftLookupInput {
	const own = new Set(config.ownAddresses);
	const others = (addresses: string[]) => {
		const seen = new Set(own);
		return addresses.filter((address) => {
			const key = address.toLowerCase();
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	};
	let to = others(
		original.addresses.replyTo.length
			? original.addresses.replyTo
			: original.addresses.from,
	);
	// Replying to an outgoing message follows up with its original recipients.
	if (
		!to.length &&
		original.addresses.from.some((address) => own.has(address.toLowerCase()))
	)
		to = others(original.addresses.to);
	const cc = input.replyAll
		? others([...original.addresses.to, ...original.addresses.cc]).filter(
				(address) =>
					!to.some(
						(recipient) => recipient.toLowerCase() === address.toLowerCase(),
					),
			)
		: [];
	const from = resolveSender(
		config,
		input.from ??
			[...original.addresses.to, ...original.addresses.cc].find((address) =>
				own.has(address.toLowerCase()),
			),
	);
	const parent = parseMessageIds(original.messageId);
	const references = original.headers.references.length
		? original.headers.references
		: parseMessageIds(original.headers.inReplyTo).length === 1
			? parseMessageIds(original.headers.inReplyTo)
			: [];
	const message = OutgoingMessageSchema.safeParse({
		from,
		to,
		cc,
		bcc: [],
		subject: /^re:/i.test(original.subject)
			? original.subject
			: `Re: ${original.subject}`,
		text: input.text,
		inReplyTo: parent,
		references: [...new Set([...references, ...parent])],
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
