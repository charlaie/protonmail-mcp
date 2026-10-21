import type { ImapService } from "../../bridge/imap/service.js";
import type { InboxWritePolicy } from "../../mail/inbox/model.js";
import { findSpecialMailbox } from "../../mail/mailboxes.js";

export type BridgeMailboxes = Awaited<ReturnType<ImapService["listMailboxes"]>>;

type InboxAction = Extract<
	InboxWritePolicy,
	{ mode: "enabled" }
>["actions"][number];

const DESTINATION_NAMES = { archive: "Archive", trash: "Trash" } as const;

export function inboxDestinations(
	actions: readonly InboxAction[],
	mailboxes: BridgeMailboxes,
) {
	const destinations: string[] = [];
	for (const action of actions) {
		if (action !== "archive" && action !== "trash") continue;
		const mailbox = findSpecialMailbox(mailboxes, action);
		if (!mailbox)
			throw new Error(
				`${DESTINATION_NAMES[action]} was not returned by Bridge. Disable the ${action} action or check the account.`,
			);
		destinations.push(mailbox.path);
	}
	return destinations;
}
