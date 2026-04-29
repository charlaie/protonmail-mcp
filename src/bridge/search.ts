import type { SearchObject } from "imapflow";

import type { SearchMessagesInput } from "../mcp/schemas.js";

export function buildSearchQuery(input: SearchMessagesInput): SearchObject {
	const query: SearchObject = { all: true };

	if (input.query) {
		query.text = input.query;
	}

	if (input.from) {
		query.from = input.from;
	}

	if (input.to) {
		query.to = input.to;
	}

	if (input.subject) {
		query.subject = input.subject;
	}

	if (input.since) {
		query.since = input.since;
	}

	if (input.before) {
		query.before = input.before;
	}

	return query;
}
