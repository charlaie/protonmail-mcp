import type { z } from "zod";
import type { MessageContent } from "@/mail/message.js";
import { outgoingMedia } from "@/mail/outgoing/media/model.js";
import { OutgoingMessageSchema } from "@/mail/outgoing/message.js";
import { hashContent } from "@/shared/content-hash.js";
import type { ForwardEmailSchema } from "./requests.js";

type QuotedSource = ReturnType<typeof quotedSource>;

// Only fields actually quoted into the forward are bound. Original Bcc and attachments are never copied.
function quotedSource(original: MessageContent) {
	return {
		messageId: original.messageId,
		from: original.headers.from ?? original.from.join(", "),
		to: original.headers.to,
		cc: original.headers.cc,
		date: original.headers.date,
		subject: original.subject,
		text: original.text,
	};
}

function forwardedHeader(source: QuotedSource) {
	const lines = [
		"---------- Forwarded message ----------",
		`From: ${source.from}`,
	];
	if (source.date) lines.push(`Date: ${source.date}`);
	lines.push(`Subject: ${source.subject}`);
	if (source.to) lines.push(`To: ${source.to}`);
	if (source.cc) lines.push(`Cc: ${source.cc}`);
	return lines.join("\n");
}

function forwardSubject(originalSubject: string) {
	return /^fwd:/i.test(originalSubject)
		? originalSubject
		: `Fwd: ${originalSubject}`;
}

export function forwardFingerprint(original: MessageContent) {
	return hashContent(quotedSource(original));
}

export function forwardMessage(
	sender: string,
	original: MessageContent,
	request: z.infer<typeof ForwardEmailSchema>,
) {
	const source = quotedSource(original);
	const quoted = `${forwardedHeader(source)}\n\n${source.text}`;
	return OutgoingMessageSchema.parse({
		from: sender,
		to: request.to,
		cc: request.cc ?? [],
		bcc: request.bcc ?? [],
		subject: request.subject ?? forwardSubject(original.subject),
		text: [request.text, quoted].filter(Boolean).join("\n\n"),
		inReplyTo: [],
		references: [],
		media: outgoingMedia(request),
	});
}
