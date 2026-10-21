import { z } from "zod";
import { AttachmentPermissionSchema } from "../mail/attachments/formats.js";
import { InboxActionNameSchema } from "../mail/inbox/model.js";
import { DomainSchema } from "./schema.js";

export function splitCsv(value: string) {
	return value
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function selectedMailbox(entry: string, mailboxes: string[]) {
	if (/^\d+$/.test(entry)) return mailboxes[Number(entry) - 1];
	return mailboxes.find((mailbox) => mailbox === entry);
}

export function parseMailboxSelection(answer: string, mailboxes: string[]) {
	const selected = splitCsv(answer).map((entry) =>
		selectedMailbox(entry, mailboxes),
	);
	if (selected.length === 0) throw new Error("Select at least one mailbox.");

	const known = selected.filter((mailbox) => mailbox !== undefined);
	if (known.length !== selected.length)
		throw new Error(
			"Unknown mailbox selection. Use numbers from the list or exact mailbox paths.",
		);
	return [...new Set(known)];
}

export function parseSenderEmails(answer: string) {
	return z.array(z.email()).parse(splitCsv(answer));
}

export function parseInboxActions(answer: string) {
	return [...new Set(z.array(InboxActionNameSchema).parse(splitCsv(answer)))];
}

export function parseSenderDomains(answer: string) {
	return z.array(DomainSchema).parse(splitCsv(answer));
}

export function parseAttachmentExtensions(answer: string) {
	const extensions = splitCsv(answer).map((extension) =>
		extension.toLowerCase(),
	);
	return [...new Set(z.array(AttachmentPermissionSchema).parse(extensions))];
}

export function parseAttachmentApproval(answer: string) {
	switch (answer.trim().toLowerCase()) {
		case "y":
		case "yes":
			return true;
		case "":
		case "n":
		case "no":
			return false;
		default:
			throw new Error("Enter yes or no.");
	}
}
