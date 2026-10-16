import { z } from "zod";
import { MediaInputFields, withinMediaLimits } from "../outgoing/media.js";

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

export const SendEmailSchema = z
	.object({
		...MediaInputFields,
		operationId: z
			.uuid()
			.describe(
				"UUID for this intended write. Reuse the same UUID and arguments when checking or retrying; never replace it to retry an uncertain write.",
			),
		from: EmailAddressSchema.optional(),
		to: EmailListSchema.describe("Primary recipients for the email."),
		cc: EmailListSchema.optional().describe("Optional CC recipients."),
		bcc: EmailListSchema.optional().describe("Optional BCC recipients."),
		subject: SubjectSchema.min(1).describe(
			"Email subject line. Keep it concise and specific.",
		),
		text: TextSchema.min(1).describe(
			"Plain-text email body. Optional attachments and inlineImages are separate fields. Images use generated HTML with a text alternative.",
		),
	})
	.refine(withinMediaLimits, "Combined media exceeds 6 MiB or 20 parts.");

const DraftContentSchema = z
	.object({
		...MediaInputFields,
		from: EmailAddressSchema.optional(),
		to: EmailListSchema.optional().describe("Optional primary recipients."),
		cc: EmailListSchema.optional().describe("Optional CC recipients."),
		bcc: EmailListSchema.optional().describe("Optional BCC recipients."),
		subject: SubjectSchema.default("").describe(
			"Draft subject line. May be blank for an unfinished draft.",
		),
		text: TextSchema.default("").describe(
			"Plain-text draft body. Optional attachments and inlineImages are separate fields. Arbitrary HTML authoring is unsupported.",
		),
	})
	.refine(withinMediaLimits, "Combined media exceeds 6 MiB or 20 parts.");

export const CreateDraftSchema = DraftContentSchema.safeExtend({
	operationId: SendEmailSchema.shape.operationId,
});

const PatchRecipientsSchema = z
	.union([EmailAddressSchema, z.array(EmailAddressSchema)])
	.transform((value) => (Array.isArray(value) ? value : [value]));
const DraftPatchSchema = z.object({
	...MediaInputFields,
	operationId: SendEmailSchema.shape.operationId,
	expectedRevision: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.describe("Revision returned by get_draft. Rejects stale edits."),
	to: PatchRecipientsSchema.optional().describe(
		"Omit to preserve; [] clears recipients.",
	),
	cc: PatchRecipientsSchema.optional(),
	bcc: PatchRecipientsSchema.optional(),
	subject: SubjectSchema.optional(),
	text: TextSchema.optional(),
});
export const EditDraftSchema = DraftPatchSchema.extend({
	uidValidity: UidValiditySchema,
	uid: UidSchema,
}).refine(withinMediaLimits, "Combined media exceeds 6 MiB or 20 parts.");
export const DraftIdSchema = z
	.uuid()
	.describe(
		"Stable logical draft ID returned by get_draft or a draft operation. Scoped to this account's journal and preserved across server-managed edits.",
	);
export const EditDraftRequestSchema = z.union([
	EditDraftSchema.strict(),
	DraftPatchSchema.extend({ draftId: DraftIdSchema })
		.strict()
		.refine(withinMediaLimits, "Combined media exceeds 6 MiB or 20 parts."),
]);

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
export const GetDraftSchema = z.union([
	GetMessageSchema.strict(),
	z.strictObject({ draftId: DraftIdSchema }),
]);
export type GetDraftInput = z.infer<typeof GetDraftSchema>;
export type EditDraftRequest = z.infer<typeof EditDraftRequestSchema>;

export const ForwardEmailSchema = z
	.object({
		...SendEmailSchema.shape,
		source: GetMessageSchema.describe(
			"Original message whose allowed headers and plain text are quoted. Original attachments are not included automatically.",
		),
		text: TextSchema.default("").describe(
			"Optional introduction before the forwarded message.",
		),
		subject: SubjectSchema.optional().describe(
			"Optional subject. Defaults to Fwd: plus the original subject.",
		),
	})
	.refine(withinMediaLimits, "Combined media exceeds 6 MiB or 20 parts.");

export const SendDraftSchema = z.object({
	operationId: SendEmailSchema.shape.operationId,
	uidValidity: UidValiditySchema,
	uid: UidSchema,
});
export const SendDraftRequestSchema = z.union([
	SendDraftSchema.strict(),
	z.strictObject({
		operationId: SendEmailSchema.shape.operationId,
		draftId: DraftIdSchema,
	}),
]);
export const ListOperationsSchema = z.object({
	limit: z.number().int().min(1).max(100).default(50),
	offset: z.number().int().min(0).default(0),
});
export const GetSendOperationSchema = z.object({
	operationId: SendEmailSchema.shape.operationId,
});
export const CreateReplyDraftSchema = GetMessageSchema.extend({
	...MediaInputFields,
	from: EmailAddressSchema.optional(),
	operationId: SendEmailSchema.shape.operationId,
	replyAll: z
		.boolean()
		.default(false)
		.describe(
			"Include the original To and Cc recipients, excluding configured own addresses. Original Bcc recipients are never copied.",
		),
	text: TextSchema.default("").describe(
		"Plain-text reply body. May be empty for an unfinished reply draft.",
	),
}).refine(withinMediaLimits, "Combined media exceeds 6 MiB or 20 parts.");

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
