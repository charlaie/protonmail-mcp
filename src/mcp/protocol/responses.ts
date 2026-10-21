import { toolError } from "../../shared/mail-error.js";

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

/** Return one page of journal operations; `nextOffset` is null once a page is short. */
export function operationPageResponse<Operation>(
	operations: Operation[],
	page: { limit: number; offset: number },
	present: (operation: Operation) => object,
) {
	const isFullPage = operations.length === page.limit;
	return jsonResponse({
		operations: operations.map(present),
		nextOffset: isFullPage ? page.offset + page.limit : null,
	});
}
