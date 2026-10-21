import type { ListResponse } from "imapflow";
import { MailError } from "../../shared/mail-error.js";
import { findSpecialMailbox } from "../mailboxes.js";
import type { InboxPlan, ManageMessageInput } from "./model.js";

type MailboxKind = "drafts" | "view" | "label" | "folder";
type InboxChange = ManageMessageInput["change"];

const FLAG_CHANGES = {
	mark_read: { flag: "\\Seen", enabled: true },
	mark_unread: { flag: "\\Seen", enabled: false },
	star: { flag: "\\Flagged", enabled: true },
	unstar: { flag: "\\Flagged", enabled: false },
} as const;

function hasRole(mailbox: ListResponse, role: string) {
	return mailbox.specialUse === role || mailbox.flags.has(role);
}

function isStarredView(mailbox: ListResponse) {
	return hasRole(mailbox, "\\Flagged") || mailbox.path === "Starred";
}

function isLabel(mailbox: ListResponse, mailboxes: ListResponse[]) {
	const namespaces = mailboxes
		.filter(
			(namespace) =>
				namespace.name === "Labels" && namespace.flags.has("\\Noselect"),
		)
		.map((namespace) => `${namespace.path}${namespace.delimiter}`);
	return [`Labels${mailbox.delimiter}`, ...namespaces].some((prefix) =>
		mailbox.path.startsWith(prefix),
	);
}

export function mailboxKind(
	mailbox: ListResponse,
	mailboxes: ListResponse[],
): MailboxKind {
	if (hasRole(mailbox, "\\Drafts") || mailbox.name === "Drafts")
		return "drafts";
	if (
		hasRole(mailbox, "\\All") ||
		mailbox.path === "All Mail" ||
		isStarredView(mailbox)
	)
		return "view";
	return isLabel(mailbox, mailboxes) ? "label" : "folder";
}

function findSelectable(mailboxes: ListResponse[], path: string | undefined) {
	return mailboxes.find(
		(mailbox) => mailbox.path === path && !mailbox.flags.has("\\Noselect"),
	);
}

function moveDestination(
	change: Exclude<InboxChange, { action: keyof typeof FLAG_CHANGES }>,
	mailboxes: ListResponse[],
) {
	switch (change.action) {
		case "archive":
		case "trash":
			return findSpecialMailbox(mailboxes, change.action)?.path;
		case "move":
		case "remove_label":
			return change.destination;
		case "apply_label":
			return change.label;
		default: {
			const exhaustive: never = change;
			return exhaustive;
		}
	}
}

function requireValidPlacement(
	action: InboxChange["action"],
	sourceKind: MailboxKind,
	targetKind: MailboxKind,
	sameMailbox: boolean,
) {
	if (sourceKind === "view" || targetKind === "view")
		throw new MailError(
			"INVALID_INPUT",
			"Move from the message's ordinary folder to an ordinary folder or use explicit label actions. All Mail and Starred are views, not placement destinations.",
			"never",
		);
	if (targetKind === "drafts" || sameMailbox)
		throw new MailError(
			"INVALID_INPUT",
			"Choose a different destination outside Drafts.",
			"never",
		);

	if (action === "apply_label") {
		if (targetKind !== "label" || sourceKind === "label")
			throw new MailError(
				"INVALID_INPUT",
				"Apply a label from the message's ordinary folder to an exact Labels mailbox path.",
				"never",
			);
		return;
	}
	if (action === "remove_label") {
		if (sourceKind !== "label" || targetKind !== "folder")
			throw new MailError(
				"INVALID_INPUT",
				"Remove a label by moving from its Labels mailbox to an ordinary folder. This also chooses the message's destination folder.",
				"never",
			);
		return;
	}
	if (sourceKind === "label" || targetKind === "label")
		throw new MailError(
			"INVALID_INPUT",
			"Use apply_label or remove_label for label projections. Ordinary moves cannot change labels implicitly.",
			"never",
		);
}

export function inboxPlan(
	input: ManageMessageInput,
	mailboxes: ListResponse[],
): InboxPlan {
	const source = findSelectable(mailboxes, input.mailbox);
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

	const { change } = input;
	switch (change.action) {
		case "mark_read":
		case "mark_unread":
		case "star":
		case "unstar":
			return {
				kind: "flag",
				...FLAG_CHANGES[change.action],
				sourceMayDisappear: change.action === "unstar" && isStarredView(source),
			};
	}

	const target = findSelectable(mailboxes, moveDestination(change, mailboxes));
	if (!target)
		throw new MailError(
			"NOT_FOUND",
			"Destination mailbox is not selectable. Refresh list_mailboxes.",
			"configure",
		);
	requireValidPlacement(
		change.action,
		sourceKind,
		mailboxKind(target, mailboxes),
		target.path === source.path,
	);
	return {
		kind: "move",
		destination: target.path,
		retainsSource: change.action === "apply_label",
	};
}
