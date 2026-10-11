import type { ParsedMail } from "mailparser";
import nodemailer from "nodemailer";
import { safeErrorMessage } from "../shared/errors.js";
import { MailError } from "../shared/mail-error.js";
import type { BridgeConfig } from "./config.js";
import { inspectDraft } from "./draft-content.js";
import type { CreateDraftInput, EditDraftInput } from "./schemas.js";
import type { ImapClient } from "./session.js";

export type CreateDraftLookupInput = CreateDraftInput & {
	mailbox: string;
	from?: string;
	inReplyTo?: string[];
	references?: string[];
};
export type EditDraftLookupInput = EditDraftInput & { mailbox: string };

async function composeDraft(
	config: BridgeConfig,
	input: CreateDraftLookupInput,
	original?: ParsedMail,
) {
	const transport = nodemailer.createTransport({
		streamTransport: true,
		buffer: true,
		newline: "windows",
	});
	try {
		const info = await transport.sendMail({
			from: original?.from?.text ?? input.from ?? config.user,
			to: input.to,
			cc: input.cc,
			bcc: input.bcc,
			subject: input.subject,
			text: input.text,
			messageId: original?.messageId,
			inReplyTo: original?.inReplyTo ?? input.inReplyTo?.join(" "),
			references: original?.references ?? input.references,
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
	let result: Awaited<ReturnType<ImapClient["append"]>>;
	try {
		result = await client.append(
			input.mailbox,
			draft.content,
			["\\Seen", "\\Draft"],
			new Date(),
		);
	} catch (error) {
		throw new MailError(
			"OPERATION_FAILED",
			`Draft append could not be confirmed for Message-ID ${draft.messageId}. Inspect Drafts before retrying.`,
			"reconcile",
			{ cause: error },
		);
	}
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
		status: "created" as const,
		mailbox: input.mailbox,
		...(await appendDraft(client, config, input)),
	};
}

export async function editDraft(
	client: ImapClient,
	config: BridgeConfig,
	input: EditDraftLookupInput,
) {
	await client.mailboxOpen(input.mailbox);
	if (!client.capabilities.has("UIDPLUS"))
		return {
			status: "blocked_uidplus_required" as const,
			mailbox: input.mailbox,
			oldUid: input.uid,
			reason:
				"Draft editing requires UIDPLUS to delete only the original. Edit it in Proton Mail.",
		};
	let inspected: Awaited<ReturnType<typeof inspectDraft>>;
	try {
		inspected = await inspectDraft(client, input);
	} catch (error) {
		if (
			!(error instanceof MailError) ||
			(error.code !== "NOT_FOUND" && error.code !== "UNSUPPORTED_CONTENT")
		)
			throw error;
		return {
			status:
				error.code === "NOT_FOUND"
					? ("not_found" as const)
					: ("blocked_unsupported_draft" as const),
			mailbox: input.mailbox,
			oldUid: input.uid,
			reason: error.message,
		};
	}
	const { original } = inspected;
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
		const current = await inspectDraft(client, input);
		if (current.fingerprint !== inspected.fingerprint)
			throw new MailError(
				"DRAFT_CHANGED",
				"Original draft changed after replacement. It was retained.",
				"reconcile",
			);
		if (await client.messageDelete(input.uid, { uid: true }))
			return { status: "updated" as const, ...result };
		return {
			status: "replacement_created_old_delete_failed" as const,
			...result,
			reason:
				"The replacement draft was saved, but deletion of the old draft was not confirmed. Inspect both drafts before retrying.",
		};
	} catch (error) {
		return {
			status: "replacement_created_old_delete_failed" as const,
			...result,
			reason: `The replacement draft was saved, but deletion of the old draft was not confirmed: ${safeErrorMessage(error)}. Inspect both drafts before retrying.`,
		};
	}
}
