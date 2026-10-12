import { z } from "zod";

const EmailAddressSchema = z.email().describe("A single email address.");
const EmailListSchema = z
	.union([EmailAddressSchema, z.array(EmailAddressSchema).min(1)])
	.transform((value) => (Array.isArray(value) ? value : [value]))
	.describe("One email address or a non-empty array of email addresses.");

const SubjectSchema = z
	.string()
	.max(998)
	.regex(/^[^\r\n]*$/, "Subject must be a single line.");
const TextSchema = z
	.string()
	.max(100_000, "Email body must be at most 100,000 characters.");
const UidSchema = z.number().int().min(1).max(4_294_967_295);
const UidValiditySchema = z
	.string()
	.regex(/^[1-9]\d*$/, "Expected UIDVALIDITY returned with the message.")
	.describe(
		"Mailbox UIDVALIDITY returned by search_messages or create_draft. Prevents using an obsolete UID after a mailbox reset.",
	);

export const SendEmailSchema = z.object({
	operationId: z
		.uuid()
		.describe(
			"A new UUID for this send. Reuse the same UUID and arguments when checking or retrying this operation; never replace it to retry an uncertain send.",
		),
	to: EmailListSchema.describe("Primary recipients for the email."),
	cc: EmailListSchema.optional().describe("Optional CC recipients."),
	bcc: EmailListSchema.optional().describe("Optional BCC recipients."),
	subject: SubjectSchema.min(1).describe(
		"Email subject line. Keep it concise and specific.",
	),
	text: TextSchema.min(1).describe(
		"Plain-text email body. HTML and attachments are not supported by this tool.",
	),
});

const DraftContentSchema = z.object({
	to: EmailListSchema.optional().describe("Optional primary recipients."),
	cc: EmailListSchema.optional().describe("Optional CC recipients."),
	bcc: EmailListSchema.optional().describe("Optional BCC recipients."),
	subject: SubjectSchema.default("").describe(
		"Draft subject line. May be blank for an unfinished draft.",
	),
	text: TextSchema.default("").describe(
		"Plain-text draft body. HTML and attachments are not supported by this tool.",
	),
});

export const CreateDraftSchema = DraftContentSchema;

export const EditDraftSchema = DraftContentSchema.extend({
	uidValidity: UidValiditySchema,
	uid: UidSchema.describe("IMAP UID of the existing draft message to replace."),
});

const MailboxSchema = z
	.string()
	.min(1)
	.describe("IMAP mailbox/folder path to read from.");
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

export const GetMessageSchema = z.object({
	mailbox: MailboxSchema,
	uidValidity: UidValiditySchema,
	uid: UidSchema.describe(
		"IMAP UID of the message, usually returned by search_messages.",
	),
});

export const SendDraftSchema = z.object({
	operationId: SendEmailSchema.shape.operationId,
	uidValidity: UidValiditySchema,
	uid: UidSchema,
});
export const GetSendOperationSchema = z.object({
	operationId: SendEmailSchema.shape.operationId,
});
export const CreateReplyDraftSchema = GetMessageSchema.extend({
	replyAll: z
		.boolean()
		.default(false)
		.describe(
			"Include the original To and Cc recipients, excluding configured own addresses. Original Bcc recipients are never copied.",
		),
	text: TextSchema.default("").describe(
		"Plain-text reply body. May be empty for an unfinished reply draft.",
	),
});

export const ListAttachmentsSchema = GetMessageSchema;
export const GetAttachmentSchema = GetMessageSchema.extend({
	attachmentId: z
		.string()
		.max(100)
		.regex(/^[1-9]\d*(?:\.[1-9]\d*)*$/)
		.describe(
			"Attachment ID returned by list_attachments for this exact message. Not a filename or filesystem path.",
		),
}).strict();

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

export type SendEmailInput = z.infer<typeof SendEmailSchema>;
export type CreateDraftInput = z.infer<typeof CreateDraftSchema>;
export type EditDraftInput = z.infer<typeof EditDraftSchema>;
export type SearchMessagesInput = z.infer<typeof SearchMessagesSchema>;
export type GetThreadInput = z.infer<typeof GetThreadSchema>;

export type GetMessageInput = z.infer<typeof GetMessageSchema>;
export type GetAttachmentInput = z.infer<typeof GetAttachmentSchema>;
