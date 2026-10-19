import { simpleParser } from "mailparser";
import {
	checkUidValidity,
	FETCH_BATCH_SIZE,
	type MessageFilter,
	parseMessageIds,
	readMessage,
	SUMMARY_FIELDS,
} from "./messages.js";
import type { GetThreadInput } from "./requests.js";
import { messageSummary } from "./serializers.js";
import type { ImapClient } from "./session.js";
import {
	bridgeThreadIdentity,
	normalizeThreadId,
	THREAD_HEADERS,
	threadIdentityIds,
	threadSearchTerms,
} from "./thread-identity.js";

export type ThreadLookupInput = Omit<GetThreadInput, "mailboxes"> & {
	mailboxes: string[];
};

async function fetchThreadMessages(
	client: ImapClient,
	mailbox: string,
	uidValidity: string,
	uids: number[],
) {
	if (uids.length === 0) return [];
	const fetched = await client.fetchAll(
		uids,
		{ ...SUMMARY_FIELDS, headers: THREAD_HEADERS },
		{ uid: true },
	);
	return Promise.all(
		fetched.map(async (message) => {
			const parsed = message.headers
				? await simpleParser(message.headers, {
						skipHtmlToText: true,
						skipTextToHtml: true,
					})
				: undefined;
			const messageId = parsed?.messageId ?? message.envelope?.messageId;
			const references = parseMessageIds(parsed?.references);
			const identity = { messageId, ...bridgeThreadIdentity(parsed?.headers) };
			const ownIds = threadIdentityIds(identity);
			const rootReference = references.find(
				(id) => !ownIds.includes(normalizeThreadId(id) ?? ""),
			);
			return {
				...messageSummary(message, uidValidity),
				mailbox,
				...identity,
				references,
				inReplyTo: parsed?.inReplyTo ?? message.envelope?.inReplyTo,
				threadKey: normalizeThreadId(rootReference) ?? ownIds[0],
			};
		}),
	);
}
type ThreadMessage = Awaited<ReturnType<typeof fetchThreadMessages>>[number];
type FullMessage = Extract<
	Awaited<ReturnType<typeof readMessage>>,
	{ kind: "found" }
>["value"];

async function readThreadBodies(
	client: ImapClient,
	summaries: ThreadMessage[],
	accepts: MessageFilter,
) {
	type Content =
		| (ThreadMessage & FullMessage & { bodyStatus: "included" })
		| (ThreadMessage & { bodyStatus: "unavailable"; reason: string });
	const messages: Content[] = [];
	let remainingCharacters = 500_000;
	for (const message of summaries) {
		if (remainingCharacters <= 0) {
			messages.push({
				...message,
				bodyStatus: "unavailable",
				reason:
					"Thread body limit of 500,000 characters reached. Use get_message for this body.",
			});
			continue;
		}
		const result = await readMessage(client, message, accepts);
		if (
			result.kind === "found" &&
			result.value.text.length <= remainingCharacters
		) {
			remainingCharacters -= result.value.text.length;
			messages.push({ ...message, ...result.value, bodyStatus: "included" });
		} else {
			const reason =
				result.kind === "unavailable"
					? result.reason
					: result.kind === "found"
						? "Body exceeds the remaining thread limit of 500,000 characters. Use get_message for this body."
						: result.kind;
			messages.push({ ...message, bodyStatus: "unavailable", reason });
		}
	}
	return { messages };
}
function relatedIds(message: ThreadMessage) {
	return [
		...threadIdentityIds(message),
		...parseMessageIds(message.inReplyTo),
		...message.references,
	].flatMap((value) => {
		const id = normalizeThreadId(value);
		return id ? [id] : [];
	});
}

export async function getThread(
	client: ImapClient,
	input: ThreadLookupInput,
	accepts: MessageFilter,
) {
	const opened = await client.mailboxOpen(input.mailbox, { readOnly: true });
	checkUidValidity(input.uidValidity, opened.uidValidity);
	const [anchor] = await fetchThreadMessages(
		client,
		input.mailbox,
		opened.uidValidity.toString(),
		[input.uid],
	);
	if (!anchor) return { kind: "not_found" } as const;
	if (!accepts(input.mailbox, anchor)) return { kind: "denied" } as const;
	const messages = new Map<string, ThreadMessage>();
	const identityLocations = new Map<string, string>();
	const candidates = new Map<string, ThreadMessage>();
	const deniedLocations = new Set<string>();
	const searchedIds = new Set<string>();
	const pendingIds = new Set<string>();
	const mailboxes = [...new Set([input.mailbox, ...input.mailboxes])];
	function add(message: ThreadMessage) {
		const ownIds = threadIdentityIds(message);
		const existingKeys = new Set(
			ownIds.flatMap((id) => {
				const location = identityLocations.get(id);
				return location ? [location] : [];
			}),
		);
		const key =
			existingKeys.values().next().value ??
			JSON.stringify([message.mailbox, message.uid]);
		// A projection can reveal aliases or reply links missing from another copy.
		for (const duplicate of existingKeys) {
			if (duplicate === key) continue;
			messages.delete(duplicate);
			for (const [id, location] of identityLocations)
				if (location === duplicate) identityLocations.set(id, key);
		}
		if (!messages.has(key)) messages.set(key, message);
		for (const id of ownIds) identityLocations.set(id, key);
		for (const id of relatedIds(message))
			if (!searchedIds.has(id)) pendingIds.add(id);
	}
	add(anchor);
	candidates.set(JSON.stringify([anchor.mailbox, anchor.uid]), anchor);
	while (pendingIds.size > 0 && messages.size < input.limit) {
		const ids = [...pendingIds];
		pendingIds.clear();
		for (const id of ids) searchedIds.add(id);
		// A substring miss can become related when another message reveals its ID.
		for (const candidate of candidates.values()) {
			if (relatedIds(candidate).some((id) => searchedIds.has(id)))
				add(candidate);
			if (messages.size >= input.limit) break;
		}
		// A single search per mailbox and frontier. Commands share the selected mailbox.
		for (const mailbox of mailboxes) {
			if (messages.size >= input.limit) break;
			const selected = await client.mailboxOpen(mailbox, { readOnly: true });
			const uids = await client.search(
				{
					or: ids.flatMap(threadSearchTerms),
				},
				{ uid: true },
			);
			if (uids === false)
				throw new Error(
					`Proton Bridge could not search thread headers in ${mailbox}. Try again.`,
				);
			const unseen = uids.filter(
				(uid) =>
					!candidates.has(JSON.stringify([mailbox, uid])) &&
					!deniedLocations.has(JSON.stringify([mailbox, uid])),
			);
			for (
				let offset = 0;
				offset < unseen.length && messages.size < input.limit;
				offset += FETCH_BATCH_SIZE
			) {
				const batch = unseen.slice(offset, offset + FETCH_BATCH_SIZE);
				for (const message of await fetchThreadMessages(
					client,
					mailbox,
					selected.uidValidity.toString(),
					batch,
				)) {
					// HEADER search matches substrings. Traverse only exact parsed IDs.
					const location = JSON.stringify([mailbox, message.uid]);
					if (!accepts(mailbox, message)) {
						deniedLocations.add(location);
						continue;
					}
					candidates.set(location, message);
					if (relatedIds(message).some((related) => searchedIds.has(related)))
						add(message);
					if (messages.size >= input.limit) break;
				}
			}
		}
	}
	const summaries = [...messages.values()].sort(
		(a, b) =>
			Date.parse(a.date ?? "1970-01-01") - Date.parse(b.date ?? "1970-01-01") ||
			a.uid - b.uid,
	);
	const contents = input.includeText
		? await readThreadBodies(client, summaries, accepts)
		: {
				messages: summaries.map((message) => ({
					...message,
					bodyStatus: "not_requested" as const,
				})),
			};
	return {
		kind: "found",
		value: {
			threadKey: anchor.threadKey,
			limitReached: messages.size >= input.limit,
			...contents,
		},
	} as const;
}
