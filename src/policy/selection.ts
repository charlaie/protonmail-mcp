import { z } from "zod";
import { DomainSchema } from "./schema.js";

export function splitCsv(value: string) {
	return value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

export function parseMailboxSelection(answer: string, mailboxes: string[]) {
	const selected = splitCsv(answer).map((item) =>
		/^\d+$/.test(item)
			? mailboxes[Number(item) - 1]
			: mailboxes.find((mailbox) => mailbox === item),
	);
	if (selected.length === 0) throw new Error("Select at least one mailbox.");
	if (selected.some((mailbox) => mailbox === undefined))
		throw new Error(
			"Unknown mailbox selection. Use numbers from the list or exact mailbox paths.",
		);
	return [...new Set(selected.filter((mailbox) => mailbox !== undefined))];
}

export function parseSenderEmails(answer: string) {
	return z.array(z.email()).parse(splitCsv(answer));
}
export function parseSenderDomains(answer: string) {
	return z.array(DomainSchema).parse(splitCsv(answer));
}
