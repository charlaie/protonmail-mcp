import type { ParsedMail } from "mailparser";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import { safeErrorMessage } from "../shared/errors.js";
import type { BridgeConfig } from "./config.js";
import { checkUidValidity } from "./messages.js";
import type { CreateDraftInput, EditDraftInput } from "./schemas.js";
import type { ImapClient } from "./session.js";

export type CreateDraftLookupInput = CreateDraftInput & { mailbox: string };
export type EditDraftLookupInput = EditDraftInput & { mailbox: string };

async function composeDraft(
	config: BridgeConfig,
	input: CreateDraftInput,
	original?: ParsedMail,
) {
	const transport = nodemailer.createTransport({
		streamTransport: true,
		buffer: true,
		newline: "windows",
	});
	try {
		const info = await transport.sendMail({
			from: original?.from?.text ?? config.user,
			to: input.to,
			cc: input.cc,
			bcc: input.bcc,
			subject: input.subject,
			text: input.text,
			messageId: original?.messageId,
			inReplyTo: original?.inReplyTo,
			references: original?.references,
			replyTo: original?.replyTo?.text,
		});
		if (!Buffer.isBuffer(info.message))
			throw new Error("Unable to compose draft message as a buffer.");
		return { content: info.message, messageId: info.messageId };
	} finally {
		transport.close();
	}
}

async function appendDraft(
	client: ImapClient,
	config: BridgeConfig,
	input: CreateDraftLookupInput,
	original?: ParsedMail,
) {
	const draft = await composeDraft(config, input, original);
	const result = await client.append(
		input.mailbox,
		draft.content,
		["\\Seen", "\\Draft"],
		new Date(),
	);
	if (!result)
		throw new Error(`Draft was not appended to mailbox ${input.mailbox}.`);
	return {
		uid: result.uid,
		uidValidity: result.uidValidity?.toString(),
		seq: result.seq,
		messageId: draft.messageId,
	};
}

export async function createDraft(
	client: ImapClient,
	config: BridgeConfig,
	input: CreateDraftLookupInput,
) {
	await client.mailboxOpen(input.mailbox);
	return {
		status: "created",
		mailbox: input.mailbox,
		...(await appendDraft(client, config, input)),
	};
}

export async function editDraft(
	client: ImapClient,
	config: BridgeConfig,
	input: EditDraftLookupInput,
) {
	const mailbox = await client.mailboxOpen(input.mailbox);
	checkUidValidity(input.uidValidity, mailbox.uidValidity);
	if (!client.capabilities.has("UIDPLUS"))
		return {
			status: "blocked_uidplus_required",
			mailbox: input.mailbox,
			oldUid: input.uid,
			reason:
				"Draft editing requires IMAP UIDPLUS to delete only the old draft. Edit this draft in Proton Mail instead.",
		};
	const existing = await client.fetchOne(
		input.uid,
		{ uid: true, size: true, flags: true },
		{ uid: true },
	);
	if (!existing)
		return {
			status: "not_found",
			mailbox: input.mailbox,
			oldUid: input.uid,
			reason: `Draft UID ${input.uid} was not found in mailbox ${input.mailbox}.`,
		};
	if (existing.size === undefined || existing.size > 10 * 1024 * 1024)
		return {
			status: "blocked_unsupported_draft",
			mailbox: input.mailbox,
			oldUid: input.uid,
			reason:
				"Draft is larger than 10 MiB or its size is unavailable. Edit it in Proton Mail instead.",
		};
	const full = await client.fetchOne(
		input.uid,
		{ uid: true, source: true },
		{ uid: true },
	);
	if (full === false || !full.source)
		throw new Error(
			"Cannot inspect the existing draft. No replacement was created.",
		);
	const original = await simpleParser(full.source, {
		skipHtmlToText: true,
		skipTextToHtml: true,
	});
	if (
		original.attachments.length > 0 ||
		original.html ||
		existing.flags?.has("\\Deleted")
	)
		return {
			status: "blocked_unsupported_draft",
			mailbox: input.mailbox,
			oldUid: input.uid,
			reason:
				"This draft has HTML, attachments, or is marked for deletion. Edit it in Proton Mail to preserve its contents. No replacement was created.",
		};
	const replacement = await appendDraft(client, config, input, original);
	const result = {
		mailbox: input.mailbox,
		oldUid: input.uid,
		newUid: replacement.uid,
		newUidValidity: replacement.uidValidity,
		newSeq: replacement.seq,
		messageId: replacement.messageId,
	};
	try {
		if (await client.messageDelete(input.uid, { uid: true }))
			return { status: "updated", ...result };
		return {
			status: "replacement_created_old_delete_failed",
			...result,
			reason:
				"The replacement draft was saved, but deletion of the old draft was not confirmed. Inspect both drafts before retrying.",
		};
	} catch (error) {
		return {
			status: "replacement_created_old_delete_failed",
			...result,
			reason: `The replacement draft was saved, but deletion of the old draft was not confirmed: ${safeErrorMessage(error)}. Inspect both drafts before retrying.`,
		};
	}
}
