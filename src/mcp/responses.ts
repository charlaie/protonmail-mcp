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
export function jsonResponse(value: unknown) {
	return textResponse(JSON.stringify(value, null, 2));
}

export function errorResponse(error: string | object) {
	return {
		...(typeof error === "string" ? textResponse(error) : jsonResponse(error)),
		isError: true,
	};
}
