type Mailbox = {
	path: string;
	specialUse?: string;
	flags: Iterable<string>;
};

const SPECIAL_MAILBOXES = {
	drafts: { flag: "\\Drafts", fallback: "Drafts" },
	sent: { flag: "\\Sent", fallback: "Sent" },
	archive: { flag: "\\Archive", fallback: "Archive" },
	trash: { flag: "\\Trash", fallback: "Trash" },
};

function hasFlag(mailbox: Mailbox, flag: string) {
	return new Set(mailbox.flags).has(flag);
}

/** Prefer server-declared roles over conventional names, excluding namespaces. */
export function findSpecialMailbox<T extends Mailbox>(
	mailboxes: readonly T[],
	role: keyof typeof SPECIAL_MAILBOXES,
): T | undefined {
	const { flag, fallback } = SPECIAL_MAILBOXES[role];
	const selectable = mailboxes.filter(
		(mailbox) => !hasFlag(mailbox, "\\Noselect"),
	);
	return (
		selectable.find(
			(mailbox) => mailbox.specialUse === flag || hasFlag(mailbox, flag),
		) ?? selectable.find((mailbox) => mailbox.path === fallback)
	);
}
