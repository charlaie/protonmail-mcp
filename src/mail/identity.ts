import { z } from "zod";

export const UidSchema = z.number().int().min(1).max(4_294_967_295);
export const UidValiditySchema = z
	.string()
	.regex(/^[1-9]\d*$/, "Expected UIDVALIDITY returned with the message.")
	.describe(
		"Mailbox UIDVALIDITY returned by search_messages or create_draft. Prevents using an obsolete UID after a mailbox reset.",
	);

export const MailboxSchema = z
	.string()
	.min(1)
	.describe("IMAP mailbox/folder path to read from.");

export const GetMessageSchema = z.object({
	mailbox: MailboxSchema,
	uidValidity: UidValiditySchema,
	uid: UidSchema.describe(
		"IMAP UID of the message, usually returned by search_messages.",
	),
});

export type GetMessageInput = z.infer<typeof GetMessageSchema>;
