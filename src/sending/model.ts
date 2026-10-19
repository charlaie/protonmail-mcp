import { z } from "zod";

import { GetMessageSchema } from "../mail/identity.js";
import { OperationIdSchema } from "../operations/identity.js";
import { MediaMetadataSchema, outgoingMedia } from "../outgoing/media.js";
import {
	MessageIdSchema,
	type OutgoingMessage,
	OutgoingMessageSchema,
} from "../outgoing/message.js";
import { hashContent } from "../shared/content-hash.js";
import type { SendEmailInput } from "./requests.js";

export const SendSourceSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("email") }),
	GetMessageSchema.extend({
		kind: z.literal("forward"),
		fingerprint: z.string(),
	}),
	GetMessageSchema.extend({
		kind: z.literal("draft"),
		fingerprint: z.string(),
		draftMessageId: z.string().optional(),
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
	operationId: OperationIdSchema,
	messageId: MessageIdSchema,
	requestHash: z.string(),
	contentHash: z.string(),
	source: SendSourceSchema,
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
	outcome: SendOutcomeSchema,
	draftCleanup: DraftCleanupSchema,
	sentCopies: z.array(GetMessageSchema).default([]),
	media: z.array(MediaMetadataSchema).optional(),
});
export type SendOperation = z.infer<typeof SendOperationSchema>;

export function sendContentHash(message: OutgoingMessage, source: SendSource) {
	return hashContent({
		message: OutgoingMessageSchema.parse(message),
		source: SendSourceSchema.parse(source),
	});
}

export function sendMessageId(operationId: string) {
	return `<${OperationIdSchema.parse(operationId)}@protonmail-mcp.local>`;
}

export function newEmailMessage(
	sender: string,
	input: SendEmailInput,
): OutgoingMessage {
	return OutgoingMessageSchema.parse({
		from: sender,
		to: input.to,
		cc: input.cc ?? [],
		bcc: input.bcc ?? [],
		subject: input.subject,
		text: input.text,
		...(input.attachments?.length || input.inlineImages?.length
			? { media: outgoingMedia(input) }
			: {}),
		inReplyTo: [],
		references: [],
	});
}
