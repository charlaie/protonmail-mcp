import { createHash } from "node:crypto";
import { z } from "zod";
import { GetMessageSchema, SendEmailSchema } from "../bridge/schemas.js";

const HeaderSchema = z
	.string()
	.max(998)
	.regex(/^[^\r\n]*$/);
const MessageIdSchema = z
	.string()
	.max(998)
	.regex(/^<[^<>\s]+@[^<>\s]+>$/);
export const OutgoingMessageSchema = z
	.object({
		from: HeaderSchema.min(1),
		to: z.array(z.email()),
		cc: z.array(z.email()),
		bcc: z.array(z.email()),
		subject: HeaderSchema,
		text: z.string().max(100_000),
		inReplyTo: z.array(MessageIdSchema),
		references: z.array(MessageIdSchema),
		replyTo: HeaderSchema.optional(),
	})
	.refine(
		(message) => message.to.length + message.cc.length + message.bcc.length > 0,
		"At least one recipient is required.",
	);
export type OutgoingMessage = z.infer<typeof OutgoingMessageSchema>;

export const SendSourceSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("email") }),
	GetMessageSchema.extend({
		kind: z.literal("draft"),
		fingerprint: z.string(),
	}),
]);
export type SendSource = z.infer<typeof SendSourceSchema>;
export const DraftCleanupSchema = z.discriminatedUnion("status", [
	z.object({ status: z.literal("not_applicable") }),
	z.object({ status: z.literal("pending") }),
	z.object({ status: z.literal("deleted") }),
	z.object({ status: z.literal("retained"), reason: z.string() }),
	z.object({ status: z.literal("failed"), reason: z.string() }),
]);
export type DraftCleanup = z.infer<typeof DraftCleanupSchema>;
const AcceptedFields = {
	accepted: z.array(z.string()),
	rejected: z.array(z.string()),
};
export const SmtpOutcomeSchema = z.discriminatedUnion("status", [
	z.object({ status: z.literal("accepted"), ...AcceptedFields }),
	z.object({ status: z.literal("partially_accepted"), ...AcceptedFields }),
	z.object({ status: z.literal("rejected"), reason: z.string() }),
	z.object({ status: z.literal("uncertain"), reason: z.string() }),
]);
export type SmtpOutcome = z.infer<typeof SmtpOutcomeSchema>;
export const SendOutcomeSchema = z.union([
	SmtpOutcomeSchema,
	z.object({ status: z.literal("prepared") }),
	z.object({ status: z.literal("submitting") }),
]);
export const SendOperationSchema = z.object({
	operationId: SendEmailSchema.shape.operationId,
	messageId: MessageIdSchema,
	requestHash: z.string(),
	contentHash: z.string(),
	source: SendSourceSchema,
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
	outcome: SendOutcomeSchema,
	draftCleanup: DraftCleanupSchema,
	sentCopies: z.array(GetMessageSchema).default([]),
});
export type SendOperation = z.infer<typeof SendOperationSchema>;

export function hashContent(value: unknown) {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function sendContentHash(message: OutgoingMessage, source: SendSource) {
	return hashContent({
		message: OutgoingMessageSchema.parse(message),
		source: SendSourceSchema.parse(source),
	});
}

export function sendMessageId(operationId: string) {
	return `<${SendEmailSchema.shape.operationId.parse(operationId)}@protonmail-mcp.local>`;
}

export function newEmailMessage(
	sender: string,
	input: z.infer<typeof SendEmailSchema>,
): OutgoingMessage {
	return OutgoingMessageSchema.parse({
		from: sender,
		to: input.to,
		cc: input.cc ?? [],
		bcc: input.bcc ?? [],
		subject: input.subject,
		text: input.text,
		inReplyTo: [],
		references: [],
	});
}
