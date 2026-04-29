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

const MailboxSchema = z
	.string()
	.min(1)
	.default("INBOX")
	.describe("IMAP mailbox/folder path to read from. Defaults to INBOX.");
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
	mailbox: z
		.string()
		.min(1)
		.describe("IMAP mailbox/folder path containing the message."),
	uid: z
		.number()
		.int()
		.positive()
		.describe("IMAP UID of the message, usually returned by search_messages."),
});

export type SendEmailInput = z.infer<typeof SendEmailSchema>;
export type SearchMessagesInput = z.infer<typeof SearchMessagesSchema>;
