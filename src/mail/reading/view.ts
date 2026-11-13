import { z } from "zod";
import { GetMessageSchema } from "@/mail/identity.js";
import {
	type MessageContent,
	type MessageSummary,
	MessageSummarySchema,
	type OmittedEntries,
} from "@/mail/message.js";
import { MailError } from "@/shared/mail-error.js";

/**
 * Model-facing reads repeat metadata on every page and in every batch or
 * thread item, so lists and strings are capped. Internal composition keeps
 * complete MessageContent.
 */
export const READ_VIEW_LIMITS = {
	listEntries: 20,
	references: 10,
	subjectChars: 1_000,
	entryChars: 320,
	defaultTextChars: 4_000,
	maxTextChars: 16_000,
};

// A limit of 1 could stop before a surrogate pair and make no progress.
export const TextLimitSchema = z
	.number()
	.int()
	.min(2)
	.max(READ_VIEW_LIMITS.maxTextChars)
	.default(READ_VIEW_LIMITS.defaultTextChars)
	.describe(
		"Maximum body characters per page (UTF-16 units), default 4000, maximum 16000.",
	);

export const TextPageFields = {
	textOffset: z
		.number()
		.int()
		.min(0)
		.max(Number.MAX_SAFE_INTEGER)
		.default(0)
		.describe("UTF-16 offset; use textPage.nextOffset to continue."),
	textLimit: TextLimitSchema,
};
export const ReadMessageSchema = GetMessageSchema.extend(TextPageFields);
export type TextPageRequest = { textOffset: number; textLimit: number };

export const TextPageSchema = z.object({
	offset: z.number().int().nonnegative(),
	totalChars: z.number().int().nonnegative(),
	nextOffset: z.number().int().nonnegative().nullable(),
});

export const MessageViewSchema = MessageSummarySchema.extend({
	messageId: z.string().optional(),
	replyTo: z.array(z.string()),
	bcc: z.array(z.string()),
	inReplyTo: z.string().optional(),
	references: z.array(z.string()),
	text: z.string(),
	textPage: TextPageSchema,
});

function splitsSurrogatePair(text: string, offset: number) {
	const previous = text.charCodeAt(offset - 1);
	const current = text.charCodeAt(offset);
	return (
		previous >= 0xd800 &&
		previous <= 0xdbff &&
		current >= 0xdc00 &&
		current <= 0xdfff
	);
}

function clip(value: string, maxChars: number) {
	if (value.length <= maxChars) return value;
	let end = maxChars - 1;
	if (splitsSurrogatePair(value, end)) end--;
	return `${value.slice(0, end)}…`;
}

function clipOptional(value: string | undefined) {
	return value === undefined
		? undefined
		: clip(value, READ_VIEW_LIMITS.entryChars);
}

const LIST_FIELDS = [
	"from",
	"senderEmails",
	"to",
	"cc",
	"bcc",
	"replyTo",
] as const;

type BoundableMessage = MessageSummary & {
	bcc?: string[];
	replyTo?: string[];
	references?: string[];
	messageId?: string;
	inReplyTo?: string;
};

/** Caps metadata and reports how many list entries were left out. */
export function boundedMessage<Message extends BoundableMessage>(
	message: Message,
) {
	const omitted: OmittedEntries = {};
	const changes: Partial<BoundableMessage> = {
		subject: clip(message.subject, READ_VIEW_LIMITS.subjectChars),
		messageId: clipOptional(message.messageId),
		inReplyTo: clipOptional(message.inReplyTo),
	};
	for (const field of LIST_FIELDS) {
		const values = message[field];
		if (!values) continue;
		if (values.length > READ_VIEW_LIMITS.listEntries)
			omitted[field] = values.length - READ_VIEW_LIMITS.listEntries;
		changes[field] = values
			.slice(0, READ_VIEW_LIMITS.listEntries)
			.map((value) => clip(value, READ_VIEW_LIMITS.entryChars));
	}
	if (message.references) {
		// The newest references name the closest ancestors.
		const { references } = message;
		if (references.length > READ_VIEW_LIMITS.references)
			omitted.references = references.length - READ_VIEW_LIMITS.references;
		changes.references = references
			.slice(-READ_VIEW_LIMITS.references)
			.map((value) => clip(value, READ_VIEW_LIMITS.entryChars));
	}
	for (const field of ["messageId", "inReplyTo"] as const) {
		if (changes[field] === undefined) delete changes[field];
	}
	return {
		...message,
		...changes,
		...(Object.keys(omitted).length > 0 ? { omitted } : {}),
	};
}

/** Returns one page of body text without splitting a surrogate pair. */
export function pageText(text: string, request: TextPageRequest) {
	const { textOffset: offset, textLimit } = request;
	if (offset > text.length || splitsSurrogatePair(text, offset)) {
		throw new MailError(
			"INVALID_INPUT",
			"Invalid body offset. Use textPage.nextOffset from the previous page.",
			"safe",
		);
	}
	let end = Math.min(text.length, offset + textLimit);
	if (splitsSurrogatePair(text, end)) end--;
	return {
		text: text.slice(offset, end),
		textPage: {
			offset,
			totalChars: text.length,
			nextOffset: end < text.length ? end : null,
		},
	};
}

/** Bounded external view of one message with a single body page. */
export function messageView(
	message: MessageContent,
	request: TextPageRequest,
): z.infer<typeof MessageViewSchema> {
	const { headers, addresses, text, ...summary } = message;
	return {
		...boundedMessage({
			...summary,
			replyTo: addresses.replyTo,
			bcc: addresses.bcc,
			inReplyTo: headers.inReplyTo,
			references: headers.references,
		}),
		...pageText(text, request),
	};
}
