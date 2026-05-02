import { z } from "zod";

/** Convert error to a safe string */
export function safeErrorMessage(error: unknown): string {
	if (error instanceof z.ZodError) {
		return `Invalid configuration or input: ${z.prettifyError(error)}`;
	}

	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
}
