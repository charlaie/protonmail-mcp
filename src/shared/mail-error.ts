import { z } from "zod";
import { safeErrorMessage } from "./errors.js";

export const RetrySchema = z.enum([
	"safe",
	"refresh_identity",
	"configure",
	"new_approval",
	"reconcile",
	"never",
]);

export const ErrorCodeSchema = z.enum([
	"POLICY_NOT_CONFIGURED",
	"POLICY_DENIED",
	"ACCOUNT_MISMATCH",
	"STALE_IDENTITY",
	"NOT_FOUND",
	"UNSUPPORTED_CONTENT",
	"CONNECTION_FAILED",
	"INVALID_INPUT",
	"APPROVAL_DENIED",
	"DRAFT_CHANGED",
	"OPERATION_CONFLICT",
	"OPERATION_BUSY",
	"STORAGE_FAILED",
	"OPERATION_FAILED",
]);

export const ToolErrorSchema = z.object({
	status: z.literal("error"),
	error: z.object({
		code: ErrorCodeSchema,
		message: z.string(),
		retry: RetrySchema,
	}),
});

export class MailError extends Error {
	constructor(
		readonly code: z.infer<typeof ErrorCodeSchema>,
		message: string,
		readonly retry: z.infer<typeof RetrySchema>,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "MailError";
	}
}

export function toolError(error: unknown): z.infer<typeof ToolErrorSchema> {
	const mailError = error instanceof MailError ? error : undefined;
	const message = typeof error === "string" ? error : safeErrorMessage(error);
	return {
		status: "error",
		error: {
			code: mailError?.code ?? "OPERATION_FAILED",
			message,
			retry: mailError?.retry ?? "never",
		},
	};
}
