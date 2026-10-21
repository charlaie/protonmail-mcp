import { type ParsedMail, simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import type { BridgeConfig } from "../../../bridge/config.js";
import { parsedAddressText } from "../../../bridge/imap/serializers.js";
import {
	mediaMailOptions,
	parsedMedia,
	verifyComposedMedia,
} from "../../outgoing/media/mime.js";
import { mediaManifest, outgoingMedia } from "../../outgoing/media/model.js";
import { resolveSender } from "../../outgoing/senders.js";
import type { CreateDraftInput, EditDraftInput } from "../requests.js";
import { draftContentHash } from "../snapshots.js";

export type CreateDraftLookupInput = CreateDraftInput & {
	mailbox: string;
	inReplyTo?: string[];
	references?: string[];
};

export type EditDraftLookupInput = EditDraftInput & { mailbox: string };

export type DraftComposition =
	| { kind: "create"; input: CreateDraftLookupInput }
	| { kind: "edit"; input: EditDraftLookupInput; original: ParsedMail };

function draftSender(config: BridgeConfig, composition: DraftComposition) {
	if (composition.kind === "create")
		return resolveSender(config, composition.input.from);
	return composition.original.from?.text ?? resolveSender(config, undefined);
}

function threadingHeaders(composition: DraftComposition) {
	if (composition.kind === "create")
		return {
			inReplyTo: composition.input.inReplyTo?.join(" "),
			references: composition.input.references,
		};
	return {
		inReplyTo: composition.original.inReplyTo,
		references: composition.original.references,
	};
}

/** Explicit media fields replace the original's parts; omitted fields keep them. */
function draftMedia(composition: DraftComposition) {
	const { input } = composition;
	const originalMedia =
		composition.kind === "edit" ? parsedMedia(composition.original) : [];
	return outgoingMedia({
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
}

// Composition is completed before the durable APPEND claim. Recovery never recomposes or appends.
export async function composeDraft(
	config: BridgeConfig,
	composition: DraftComposition,
) {
	const { input } = composition;
	const original =
		composition.kind === "edit" ? composition.original : undefined;
	const messageId = `<draft-${input.operationId}@protonmail-mcp.local>`;
	const media = draftMedia(composition);
	const text = input.text ?? original?.text ?? "";

	const transport = nodemailer.createTransport({
		streamTransport: true,
		buffer: true,
		newline: "windows",
	});
	try {
		const info = await transport.sendMail({
			from: draftSender(config, composition),
			to: input.to ?? parsedAddressText(original?.to),
			cc: input.cc ?? parsedAddressText(original?.cc),
			bcc: input.bcc ?? parsedAddressText(original?.bcc),
			subject: input.subject ?? original?.subject ?? "",
			...mediaMailOptions(text, media),
			messageId,
			...threadingHeaders(composition),
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
