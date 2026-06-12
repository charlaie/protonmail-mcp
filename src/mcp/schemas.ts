import { z } from "zod";

const EmailAddressSchema = z.email().describe("A single email address.");
const EmailListSchema = z
	.union([EmailAddressSchema, z.array(EmailAddressSchema).min(1)])
	.transform((value) => (Array.isArray(value) ? value : [value]))
	.describe("One email address or a non-empty array of email addresses.");

export const SendEmailSchema = z.object({
	to: EmailListSchema.describe("Primary recipients for the email."),
	cc: EmailListSchema.optional().describe("Optional CC recipients."),
	bcc: EmailListSchema.optional().describe("Optional BCC recipients."),
	subject: z
		.string()
		.min(1)
		.max(998)
		.describe("Email subject line. Keep it concise and specific."),
	text: z
		.string()
		.min(1)
		.describe(
			"Plain-text email body. HTML and attachments are not supported by this tool.",
		),
});

const DraftContentSchema = z.object({
	to: EmailListSchema.optional().describe("Optional primary recipients."),
	cc: EmailListSchema.optional().describe("Optional CC recipients."),
	bcc: EmailListSchema.optional().describe("Optional BCC recipients."),
	subject: z
		.string()
		.max(998)
		.default("")
		.describe("Draft subject line. May be blank for an unfinished draft."),
	text: z
		.string()
		.min(1)
		.describe(
			"Plain-text draft body. HTML and attachments are not supported by this tool.",
		),
});

export const CreateDraftSchema = DraftContentSchema;

export const EditDraftSchema = DraftContentSchema.extend({
	uid: z
		.number()
		.int()
		.positive()
		.describe("IMAP UID of the existing draft message to replace."),
});

const MailboxSchema = z
	.string()
	.min(1)
	.describe("IMAP mailbox/folder path to read from.");
const DateStringSchema = z.iso
	.date()
	.describe("Calendar date in YYYY-MM-DD format.");

export const SearchMessagesSchema = z.object({
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
});

export const GetMessageSchema = z.object({
	mailbox: MailboxSchema,
	uid: z
		.number()
		.int()
		.positive()
		.describe("IMAP UID of the message, usually returned by search_messages."),
});

export const GetThreadSchema = z.object({
	mailbox: MailboxSchema.describe(
		"Mailbox/folder path containing the anchor message.",
	),
	uid: z
		.number()
		.int()
		.positive()
		.describe("IMAP UID of the anchor message to expand into a thread."),
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

export type SendEmailInput = z.infer<typeof SendEmailSchema>;
export type CreateDraftInput = z.infer<typeof CreateDraftSchema>;
export type EditDraftInput = z.infer<typeof EditDraftSchema>;
export type SearchMessagesInput = z.infer<typeof SearchMessagesSchema>;
export type GetThreadInput = z.infer<typeof GetThreadSchema>;
