import { z } from "zod";

export const OperationIdSchema = z
	.uuid()
	.describe(
		"UUID for this intended write. Reuse the same UUID and arguments when checking or retrying; never replace it to retry an uncertain write.",
	);

export const ListOperationsSchema = z.object({
	limit: z.number().int().min(1).max(100).default(50),
	offset: z.number().int().min(0).default(0),
});
export const GetOperationSchema = z.object({
	operationId: OperationIdSchema,
});
