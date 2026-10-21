import { z } from "zod";

import {
	MailboxSchema,
	UidSchema,
	UidValiditySchema,
} from "@/mail/identity.js";

const DateStringSchema = z.iso
	.date()
	.describe("Calendar date in YYYY-MM-DD format.");

export const SearchMessagesSchema = z
	.object({
		mailbox: MailboxSchema,
		query: z
			.string()
			.min(1)
			.optional()
			.describe("Free-text IMAP search across message headers and body."),
		from: z
			.string()
			.min(1)
			.optional()
			.describe("Filter messages by text contained in the From header."),
		to: z
			.string()
			.min(1)
			.optional()
			.describe("Filter messages by text contained in the To header."),
		subject: z
			.string()
			.min(1)
			.optional()
			.describe("Filter messages by text contained in the Subject header."),
		since: DateStringSchema.optional().describe(
			"Only include messages received on or after this date.",
		),
		before: DateStringSchema.optional().describe(
			"Only include messages received before this date.",
		),
		limit: z
			.number()
			.int()
			.min(1)
			.max(100)
			.default(20)
			.describe("Maximum number of newest matching messages to return."),
	})
	.refine(
		(input) => !input.since || !input.before || input.since < input.before,
		{ path: ["before"], message: "before must be later than since." },
	);

export const GetThreadSchema = z.object({
	uidValidity: UidValiditySchema,
	mailbox: MailboxSchema.describe(
		"Mailbox/folder path containing the anchor message.",
	),
	uid: UidSchema.describe(
		"IMAP UID of the anchor message to expand into a thread.",
	),
	mailboxes: z
		.array(MailboxSchema)
		.min(1)
		.max(25)
		.optional()
		.describe(
			"Optional mailbox/folder paths to search for related messages. If omitted, searches every mailbox allowed by the read policy.",
		),
	limit: z
		.number()
		.int()
		.min(1)
		.max(100)
		.default(50)
		.describe("Maximum number of related messages to return."),
	includeText: z
		.boolean()
		.default(true)
		.describe(
			"Whether to include parsed plain-text bodies for returned messages.",
		),
});

export type SearchMessagesInput = z.infer<typeof SearchMessagesSchema>;
export type GetThreadInput = z.infer<typeof GetThreadSchema>;
