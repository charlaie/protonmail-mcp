import type { ParsedMail } from "mailparser";

export const STANDARD_THREAD_HEADERS = [
	"Message-ID",
	"References",
	"In-Reply-To",
];

export const THREAD_HEADERS = [
	...STANDARD_THREAD_HEADERS,
	"X-Pm-Internal-Id",
	"X-Pm-External-Id",
];

// Bridge references a message by its internal ID under this synthetic domain.
const INTERNAL_DOMAIN = "@protonmail.internalid";
const BRIDGE_INTERNAL_ID = /^[^\s<>@]{1,1024}$/u;
const BRIDGE_EXTERNAL_ID = /^<[^\s<>]+>$/u;

type ThreadIdentity = ReturnType<typeof bridgeThreadIdentity> & {
	messageId?: string;
};

export function normalizeThreadId(value: string | undefined) {
	return value?.trim().replace(/^<|>$/g, "");
}

// Repeated or malformed Bridge headers must not identify a message.
function wellFormedHeader(
	headers: ParsedMail["headers"] | undefined,
	name: string,
	pattern: RegExp,
) {
	const value = headers?.get(name);
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return pattern.test(trimmed) ? trimmed : undefined;
}

export function bridgeThreadIdentity(
	headers: ParsedMail["headers"] | undefined,
) {
	return {
		bridgeInternalId: wellFormedHeader(
			headers,
			"x-pm-internal-id",
			BRIDGE_INTERNAL_ID,
		),
		bridgeExternalId: wellFormedHeader(
			headers,
			"x-pm-external-id",
			BRIDGE_EXTERNAL_ID,
		),
	};
}

export function threadIdentityIds(message: ThreadIdentity) {
	const internalAlias = message.bridgeInternalId
		? `${message.bridgeInternalId}${INTERNAL_DOMAIN}`
		: undefined;
	const ids = [
		message.messageId,
		message.bridgeExternalId,
		internalAlias,
	].flatMap((value) => {
		const id = normalizeThreadId(value);
		return id ? [id] : [];
	});
	return [...new Set(ids)];
}

export function threadSearchTerms(id: string) {
	const terms = [...STANDARD_THREAD_HEADERS, "X-Pm-External-Id"].map(
		(header) => ({ header: { [header]: id } }),
	);
	if (id.endsWith(INTERNAL_DOMAIN))
		terms.push({
			header: { "X-Pm-Internal-Id": id.slice(0, -INTERNAL_DOMAIN.length) },
		});
	return terms;
}
