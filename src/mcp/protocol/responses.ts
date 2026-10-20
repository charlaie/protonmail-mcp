/** Return a text response. */
export function textResponse(text: string) {
	return {
		content: [
			{
				type: "text" as const,
				text,
			},
		],
	};
}

/** Return a JSON object as a text response. */
export function jsonResponse(value: object) {
	return {
		...textResponse(JSON.stringify(value, null, 2)),
		structuredContent: value,
	};
}

export function errorResponse(error: unknown) {
	return {
		...jsonResponse(toolError(error)),
		isError: true,
	};
}

import { toolError } from "../../shared/mail-error.js";
