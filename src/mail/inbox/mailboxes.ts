import type { ListResponse } from "imapflow";
import { MailError } from "../../shared/mail-error.js";
import type { InboxPlan, ManageMessageInput } from "./model.js";

export function mailboxKind(mailbox: ListResponse, mailboxes: ListResponse[]) {
	if (
		mailbox.specialUse === "\\Drafts" ||
		mailbox.flags.has("\\Drafts") ||
		mailbox.name === "Drafts"
	)
		return "drafts";
	if (
		["\\All", "\\Flagged"].some(
			(flag) => mailbox.specialUse === flag || mailbox.flags.has(flag),
		) ||
		mailbox.path === "All Mail" ||
		mailbox.path === "Starred"
	)
		return "view";
	const prefixes = [
		`Labels${mailbox.delimiter}`,
		...mailboxes
			.filter((item) => item.name === "Labels" && item.flags.has("\\Noselect"))
			.map((item) => `${item.path}${item.delimiter}`),
	];
	return prefixes.some((prefix) => mailbox.path.startsWith(prefix))
		? "label"
		: "folder";
}
export function inboxPlan(
	input: ManageMessageInput,
	mailboxes: ListResponse[],
): InboxPlan {
	const source = mailboxes.find(
		(item) => item.path === input.mailbox && !item.flags.has("\\Noselect"),
	);
	if (!source)
		throw new MailError(
			"NOT_FOUND",
			"Source mailbox is not selectable. Refresh list_mailboxes.",
			"refresh_identity",
		);
	const sourceKind = mailboxKind(source, mailboxes);
	if (sourceKind === "drafts")
		throw new MailError(
			"POLICY_DENIED",
			"Inbox tools cannot mutate Drafts. Use the draft and send tools.",
			"never",
		);
	let destination: string;
	switch (input.change.action) {
		case "mark_read":
			return {
				kind: "flag",
				flag: "\\Seen",
				enabled: true,
				sourceMayDisappear: false,
			};
		case "mark_unread":
			return {
				kind: "flag",
				flag: "\\Seen",
				enabled: false,
				sourceMayDisappear: false,
			};
		case "star":
			return {
				kind: "flag",
				flag: "\\Flagged",
				enabled: true,
				sourceMayDisappear: false,
			};
		case "unstar":
			return {
				kind: "flag",
				flag: "\\Flagged",
				enabled: false,
				sourceMayDisappear:
					source.specialUse === "\\Flagged" ||
					source.flags.has("\\Flagged") ||
					source.path === "Starred",
			};
		case "archive":
		case "trash": {
			const special =
				input.change.action === "archive" ? "\\Archive" : "\\Trash";
			const fallback = input.change.action === "archive" ? "Archive" : "Trash";
			destination =
				(
					mailboxes.find(
						(item) => item.specialUse === special || item.flags.has(special),
					) ?? mailboxes.find((item) => item.path === fallback)
				)?.path ?? "";
			break;
		}
		case "move":
		case "remove_label":
			destination = input.change.destination;
			break;
		case "apply_label":
			destination = input.change.label;
			break;
		default: {
			const exhaustive: never = input.change;
			return exhaustive;
		}
	}
	const target = mailboxes.find(
		(item) => item.path === destination && !item.flags.has("\\Noselect"),
	);
	if (!target)
		throw new MailError(
			"NOT_FOUND",
			"Destination mailbox is not selectable. Refresh list_mailboxes.",
			"configure",
		);
	const targetKind = mailboxKind(target, mailboxes);
	if (sourceKind === "view" || targetKind === "view")
		throw new MailError(
			"INVALID_INPUT",
			"Move from the message's ordinary folder to an ordinary folder or use explicit label actions. All Mail and Starred are views, not placement destinations.",
			"never",
		);
	if (targetKind === "drafts" || destination === source.path)
		throw new MailError(
			"INVALID_INPUT",
			"Choose a different destination outside Drafts.",
			"never",
		);
	if (input.change.action === "apply_label") {
		if (targetKind !== "label" || sourceKind === "label")
			throw new MailError(
				"INVALID_INPUT",
				"Apply a label from the message's ordinary folder to an exact Labels mailbox path.",
				"never",
			);
	} else if (input.change.action === "remove_label") {
		if (sourceKind !== "label" || targetKind !== "folder")
			throw new MailError(
				"INVALID_INPUT",
				"Remove a label by moving from its Labels mailbox to an ordinary folder. This also chooses the message's destination folder.",
				"never",
			);
	} else if (sourceKind === "label" || targetKind === "label") {
		throw new MailError(
			"INVALID_INPUT",
			"Use apply_label or remove_label for label projections. Ordinary moves cannot change labels implicitly.",
			"never",
		);
	}
	return {
		kind: "move",
		destination,
		retainsSource: input.change.action === "apply_label",
	};
}
