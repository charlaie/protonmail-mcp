import { type ParsedMail, simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import type { BridgeConfig } from "@/bridge/config.js";
import { parsedAddressText } from "@/bridge/imap/serializers.js";
import type { ImapClient } from "@/bridge/imap/session.js";
import type {
	CreateDraftInput,
	EditDraftInput,
} from "@/mail/drafts/requests.js";
import { draftContentHash } from "@/mail/drafts/snapshots.js";
import {
	mediaMailOptions,
	parsedMedia,
	verifyComposedMedia,
} from "@/mail/outgoing/media/mime.js";
import { mediaManifest, outgoingMedia } from "@/mail/outgoing/media/model.js";
import { resolveSender } from "@/mail/outgoing/senders.js";

export type CreateDraftLookupInput = CreateDraftInput & {
	mailbox: string;
	inReplyTo?: string[];
	references?: string[];
};
export type EditDraftLookupInput = EditDraftInput & { mailbox: string };

// Composition is completed before the durable APPEND claim. Recovery never recomposes or appends.
export async function composeDraft(
	config: BridgeConfig,
	input: CreateDraftLookupInput | EditDraftLookupInput,
	original?: ParsedMail,
) {
	const transport = nodemailer.createTransport({
		streamTransport: true,
		buffer: true,
		newline: "windows",
	});
	const messageId = `<draft-${input.operationId}@protonmail-mcp.local>`;
	const originalMedia = original ? parsedMedia(original) : [];
	const media = outgoingMedia({
		attachments:
			input.attachments ??
			originalMedia
				.filter((part) => part.kind === "attachment")
				.map((part) => part.file),
		inlineImages:
			input.inlineImages ??
			originalMedia
				.filter((part) => part.kind === "inline")
				.map((part) => part.file),
	});
	const text = input.text ?? original?.text ?? "";
	try {
		const info = await transport.sendMail({
			from:
				original?.from?.text ??
				resolveSender(config, "from" in input ? input.from : undefined),
			to: input.to ?? parsedAddressText(original?.to),
			cc: input.cc ?? parsedAddressText(original?.cc),
			bcc: input.bcc ?? parsedAddressText(original?.bcc),
			subject: input.subject ?? original?.subject ?? "",
			...mediaMailOptions(text, media),
			messageId,
			inReplyTo:
				original?.inReplyTo ??
				("inReplyTo" in input ? input.inReplyTo?.join(" ") : undefined),
			references:
				original?.references ??
				("references" in input ? input.references : undefined),
			replyTo: original?.replyTo?.text,
		});
		if (!Buffer.isBuffer(info.message))
			throw new Error("Unable to compose draft message as a buffer.");
		const parsed = await simpleParser(info.message, {
			skipHtmlToText: true,
			skipTextToHtml: true,
			skipImageLinks: true,
		});
		verifyComposedMedia(parsed, media);
		return {
			content: info.message,
			messageId,
			media: mediaManifest(media),
			contentHash: draftContentHash(parsed),
		};
	} finally {
		transport.close();
	}
}
export async function appendDraft(
	client: ImapClient,
	mailbox: string,
	content: Buffer,
) {
	return client.append(mailbox, content, ["\\Seen", "\\Draft"], new Date());
}
