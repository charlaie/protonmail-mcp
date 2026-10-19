import { z } from "zod";
import { SendOperationSchema } from "../sending/model.js";
import { RetrySchema, ToolErrorSchema } from "../shared/mail-error.js";

export const SendRecordOutputSchema = SendOperationSchema.omit({
	requestHash: true,
}).extend({ retry: RetrySchema });
export const SendOutputSchema = z.union([
	SendRecordOutputSchema,
	ToolErrorSchema,
]);
export const ListSendOperationsOutputSchema = z.union([
	z.object({
		operations: z.array(SendRecordOutputSchema),
		nextOffset: z.number().int().nullable(),
	}),
	ToolErrorSchema,
]);
