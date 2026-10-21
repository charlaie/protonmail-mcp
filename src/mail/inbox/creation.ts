import type { ListResponse } from "imapflow";
import { z } from "zod";
import type { ImapSession } from "@/bridge/imap/session.js";
import { MailError } from "@/shared/mail-error.js";

export const MailboxCreationKindSchema = z.enum(["folder", "label"]);

function isPrintable(character: string) {
	const code = character.charCodeAt(0);
	return code >= 32 && code !== 127;
}

const NameSchema = z
	.string()
	.min(1)
	.max(255)
	.refine(
		(name) =>
			name === name.trim() &&
			!/[/\\]/u.test(name) &&
			[...name].every(isPrintable) &&
			name !== "." &&
			name !== "..",
		"Use a single folder or label name without separators, control characters, or surrounding whitespace.",
	);

export const CreateMailboxSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("folder"),
		name: NameSchema,
		parent: z.string().min(1).optional(),
	}),
	z.strictObject({ kind: z.literal("label"), name: NameSchema }),
]);
export type CreateMailboxInput = z.infer<typeof CreateMailboxSchema>;

type MailboxAvailable = {
	status: "available";
	kind: CreateMailboxInput["kind"];
	path: string;
};

function namespaceRoot(mailboxes: ListResponse[], input: CreateMailboxInput) {
	const namespace = input.kind === "folder" ? "Folders" : "Labels";
	const root = mailboxes.find(
		(mailbox) => mailbox.path === namespace && mailbox.flags.has("\\Noselect"),
	);
	if (!root?.delimiter)
		throw new MailError(
			"UNSUPPORTED_CONTENT",
			`Bridge did not advertise the ${namespace} namespace. Refresh list_mailboxes or create it in Proton Mail.`,
			"configure",
		);
	return { path: root.path, delimiter: root.delimiter };
}

function requestedPath(mailboxes: ListResponse[], input: CreateMailboxInput) {
	const root = namespaceRoot(mailboxes, input);
	const parentPath =
		input.kind === "folder" ? (input.parent ?? root.path) : root.path;
	const parent = mailboxes.find((mailbox) => mailbox.path === parentPath);
	const isCustomFolder =
		parentPath.startsWith(`${root.path}${root.delimiter}`) &&
		!parent?.flags.has("\\Noselect");
	if (!parent || (parentPath !== root.path && !isCustomFolder))
		throw new MailError(
			"INVALID_INPUT",
			"Choose an existing custom folder as parent, or omit parent for a top-level folder.",
			"refresh_identity",
		);
	if (input.name.includes(root.delimiter))
		throw new MailError(
			"INVALID_INPUT",
			"Mailbox names cannot contain the advertised hierarchy delimiter.",
			"never",
		);
	return `${parentPath}${root.delimiter}${input.name}`;
}

function findAvailable(
	mailboxes: ListResponse[],
	input: CreateMailboxInput,
	path: string,
): MailboxAvailable | undefined {
	const found = mailboxes.find((mailbox) => mailbox.path === path);
	if (!found) return undefined;
	if (found.flags.has("\\Noselect"))
		throw new MailError(
			"OPERATION_CONFLICT",
			"That path exists as a non-selectable namespace. Choose another name.",
			"never",
		);
	return { status: "available", kind: input.kind, path };
}

// CREATE has desired-state semantics: an existing selectable mailbox is success.
// Retrying after a lost acknowledgement checks LIST before issuing another CREATE.
export async function createMailbox(
	run: ImapSession,
	input: CreateMailboxInput,
	authorize: () => Promise<void>,
) {
	await authorize();
	return run(async (client) => {
		const mailboxes = await client.list();
		const path = requestedPath(mailboxes, input);

		await authorize();
		const existing = findAvailable(mailboxes, input, path);
		if (existing) return existing;

		try {
			await client.mailboxCreate(path);
			const created = findAvailable(await client.list(), input, path);
			if (created) return created;
		} catch (error) {
			if (error instanceof MailError) throw error;
			throw new MailError(
				"OPERATION_FAILED",
				"Mailbox creation or subscription could not be confirmed. The mailbox may exist. Refresh list_mailboxes; retry the same kind, name and parent to check for it before creating.",
				"safe",
				{ cause: error },
			);
		}
		throw new MailError(
			"OPERATION_FAILED",
			"Mailbox creation could not be verified. Refresh list_mailboxes; retry the same kind, name and parent to check for it before creating.",
			"safe",
		);
	});
}
