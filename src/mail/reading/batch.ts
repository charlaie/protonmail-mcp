import { z } from "zod";
import { type GetMessageInput, GetMessageSchema } from "@/mail/identity.js";
import { MessageBodySchema, type MessageContent } from "@/mail/message.js";
import { ToolErrorSchema, toolError } from "@/shared/mail-error.js";

export const BATCH_READ_LIMITS = {
	maxMessages: 20,
	maxTextChars: 500_000,
	maxBytes: 1_048_576,
};
export const BatchGetMessagesSchema = z.object({
	messages: z
		.array(
			GetMessageSchema.extend({
				mailbox: GetMessageSchema.shape.mailbox.max(1024),
				uidValidity: GetMessageSchema.shape.uidValidity.max(20),
			}),
		)
		.min(1)
		.max(BATCH_READ_LIMITS.maxMessages)
		.describe(
			"Complete physical message references, read sequentially in request order, including duplicates.",
		),
});
const reference = { reference: GetMessageSchema };
export const BatchReadItemSchema = z.discriminatedUnion("kind", [
	z.object({
		...reference,
		kind: z.literal("found"),
		message: MessageBodySchema,
	}),
	z.object({ ...reference, kind: z.literal("denied") }),
	z.object({ ...reference, kind: z.literal("not_found") }),
	z.object({ ...reference, kind: z.literal("stale_identity") }),
	z.object({
		...reference,
		kind: z.literal("unavailable"),
		reason: z.string(),
	}),
	z.object({
		...reference,
		kind: z.literal("failed"),
		error: ToolErrorSchema.shape.error,
	}),
	z.object({ ...reference, kind: z.literal("budget_exhausted") }),
]);
export const BatchReadSchema = z.object({
	status: z.literal("ok"),
	items: z.array(BatchReadItemSchema),
	budget: z.object({
		maxMessages: z.number(),
		maxTextChars: z.number(),
		maxBytes: z.number(),
		returnedTextChars: z.number(),
		exhausted: z.boolean(),
	}),
});
export type BatchGetMessagesInput = z.infer<typeof BatchGetMessagesSchema>;
type BatchReadItem = z.infer<typeof BatchReadItemSchema>;
type BatchRead = z.infer<typeof BatchReadSchema>;

function readFailure(
	reference: GetMessageInput,
	cause: unknown,
): BatchReadItem {
	const { error } = toolError(cause);
	switch (error.code) {
		case "POLICY_DENIED":
			return { reference, kind: "denied" };
		case "NOT_FOUND":
			return { reference, kind: "not_found" };
		case "STALE_IDENTITY":
			return { reference, kind: "stale_identity" };
		case "UNSUPPORTED_CONTENT":
			return { reference, kind: "unavailable", reason: error.message };
		default:
			return {
				reference,
				kind: "failed",
				error: {
					...error,
					message: "Message read failed. Use get_message for details.",
				},
			};
	}
}

/** Sequential calls preserve selected-mailbox safety and bound transport concurrency to one. */
export async function batchGetMessages(input: {
	request: BatchGetMessagesInput;
	read: (reference: GetMessageInput) => Promise<MessageContent>;
}): Promise<BatchRead> {
	const request = BatchGetMessagesSchema.parse(input.request);
	const result: BatchRead = {
		status: "ok",
		items: request.messages.map((reference) => ({
			reference,
			kind: "budget_exhausted",
		})),
		budget: { ...BATCH_READ_LIMITS, returnedTextChars: 0, exhausted: false },
	};
	for (const [index, reference] of request.messages.entries()) {
		let item: BatchReadItem;
		try {
			item = { reference, kind: "found", message: await input.read(reference) };
		} catch (error) {
			item = readFailure(reference, error);
		}
		const chars = item.kind === "found" ? item.message.text.length : 0;
		result.items[index] = item;
		result.budget.returnedTextChars += chars;
		// Include references, metadata, outcomes and JSON escaping, not just body bytes.
		if (
			result.budget.returnedTextChars > BATCH_READ_LIMITS.maxTextChars ||
			Buffer.byteLength(JSON.stringify(result, null, 2), "utf8") >
				BATCH_READ_LIMITS.maxBytes
		) {
			result.items[index] = { reference, kind: "budget_exhausted" };
			result.budget.returnedTextChars -= chars;
			break;
		}
	}
	result.budget.exhausted = result.items.some(
		(item) => item.kind === "budget_exhausted",
	);
	return result;
}
