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

export function jsonResponse(value: unknown) {
	return textResponse(JSON.stringify(value, null, 2));
}
