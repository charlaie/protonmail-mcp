import type { ImapService } from "@/bridge/imap/service.js";
import type { InboxWritePolicy } from "@/mail/inbox/model.js";

type Mailboxes = Awaited<ReturnType<ImapService["listMailboxes"]>>;

export function inboxDestinations(
	actions: Extract<InboxWritePolicy, { mode: "enabled" }>["actions"],
	mailboxes: Mailboxes,
) {
	const destinations: string[] = [];
	for (const action of actions) {
		if (action !== "archive" && action !== "trash") continue;
		const specialUse = action === "archive" ? "\\Archive" : "\\Trash";
		const fallback = action === "archive" ? "Archive" : "Trash";
		const mailbox =
			mailboxes.find(
				(item) =>
					item.specialUse === specialUse || item.flags.includes(specialUse),
			) ?? mailboxes.find((item) => item.path === fallback);
		if (!mailbox)
			throw new Error(
				`${fallback} was not returned by Bridge. Disable the ${action} action or check the account.`,
			);
		destinations.push(mailbox.path);
	}
	return destinations;
}
