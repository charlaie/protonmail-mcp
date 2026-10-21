import type { z } from "zod";
import type { MessageContent } from "@/mail/message.js";
import { outgoingMedia } from "@/mail/outgoing/media/model.js";
import { OutgoingMessageSchema } from "@/mail/outgoing/message.js";
import { hashContent } from "@/shared/content-hash.js";
import type { ForwardEmailSchema } from "./requests.js";

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
export function forwardFingerprint(original: MessageContent) {
	return hashContent(quotedSource(original));
}
export function forwardMessage(
	sender: string,
	original: MessageContent,
	request: z.infer<typeof ForwardEmailSchema>,
) {
	const source = quotedSource(original);
	const header = [
		"---------- Forwarded message ----------",
		`From: ${source.from}`,
		source.date ? `Date: ${source.date}` : undefined,
		`Subject: ${source.subject}`,
		source.to ? `To: ${source.to}` : undefined,
		source.cc ? `Cc: ${source.cc}` : undefined,
	]
		.filter((value) => value !== undefined)
		.join("\n");
	return OutgoingMessageSchema.parse({
		from: sender,
		to: request.to,
		cc: request.cc ?? [],
		bcc: request.bcc ?? [],
		subject:
			request.subject ??
			(/^fwd:/i.test(original.subject)
				? original.subject
				: `Fwd: ${original.subject}`),
		text: [request.text, `${header}\n\n${source.text}`]
			.filter(Boolean)
			.join("\n\n"),
		inReplyTo: [],
		references: [],
		...(request.attachments?.length || request.inlineImages?.length
			? { media: outgoingMedia(request) }
			: {}),
	});
}
