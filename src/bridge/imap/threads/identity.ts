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
const INTERNAL_DOMAIN = "@protonmail.internalid";

export function normalizeThreadId(value: string | undefined) {
	return value?.trim().replace(/^<|>$/g, "");
}

export function bridgeThreadIdentity(
	headers: ParsedMail["headers"] | undefined,
) {
	const internal = headers?.get("x-pm-internal-id");
	const external = headers?.get("x-pm-external-id");
	const bridgeInternalId =
		typeof internal === "string" && /^[^\s<>@]{1,1024}$/u.test(internal.trim())
			? internal.trim()
			: undefined;
	const bridgeExternalId =
		typeof external === "string" && /^<[^\s<>]+>$/u.test(external.trim())
			? external.trim()
			: undefined;
	return { bridgeInternalId, bridgeExternalId };
}

type ThreadIdentity = ReturnType<typeof bridgeThreadIdentity> & {
	messageId?: string;
};
export function threadIdentityIds(message: ThreadIdentity) {
	return [
		...new Set(
			[
				message.messageId,
				message.bridgeExternalId,
				message.bridgeInternalId
					? `${message.bridgeInternalId}${INTERNAL_DOMAIN}`
					: undefined,
			].flatMap((value) => {
				const id = normalizeThreadId(value);
				return id ? [id] : [];
			}),
		),
	];
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
