import type { FetchMessageObject } from "imapflow";
import { simpleParser } from "mailparser";
import type { MessageCache } from "@/bridge/imap/reading/cache.js";
import {
	checkUidValidity,
	type MessageFilter,
	parseMessageIds,
	type ReadResult,
	readMessage,
	SUMMARY_FIELDS,
	uidBatches,
} from "@/bridge/imap/reading/messages.js";
import type { GetThreadInput } from "@/bridge/imap/reading/requests.js";
import { messageSummary } from "@/bridge/imap/serializers.js";
import type { ImapClient } from "@/bridge/imap/session.js";
import type { MessageContent } from "@/mail/message.js";
import {
	bridgeThreadIdentity,
	normalizeThreadId,
	THREAD_HEADERS,
	threadIdentityIds,
	threadSearchTerms,
} from "./identity.js";

export type ThreadLookupInput = Omit<GetThreadInput, "mailboxes"> & {
	mailboxes: string[];
};

type ThreadMessage = Awaited<ReturnType<typeof toThreadMessage>>;

type ThreadMessageContent =
	| (ThreadMessage & { text: string; bodyStatus: "included" })
	| (ThreadMessage & { bodyStatus: "unavailable"; reason: string });

const THREAD_BODY_LIMIT = 32_000;
export const THREAD_DISCOVERY_LIMITS = {
	candidates: 1_000,
	searches: 100,
	idsPerSearch: 100,
};
type DiscoveryBudget = { candidates: number; searches: number };

function messageLocation(mailbox: string, uid: number) {
	return JSON.stringify([mailbox, uid]);
}

async function toThreadMessage(
	message: FetchMessageObject,
	mailbox: string,
	uidValidity: string,
) {
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

	// Bridge may list a message's own synthetic ID in References.
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
}

async function fetchThreadMessages(
	client: ImapClient,
	mailbox: string,
	uidValidity: string,
	uids: number[],
): Promise<ThreadMessage[]> {
	if (uids.length === 0) return [];

	const fetched = await client.fetchAll(
		uids,
		{ ...SUMMARY_FIELDS, headers: THREAD_HEADERS },
		{ uid: true },
	);
	return Promise.all(
		fetched.map((message) => toThreadMessage(message, mailbox, uidValidity)),
	);
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

function compareChronologically(left: ThreadMessage, right: ThreadMessage) {
	const leftTime = Date.parse(left.date ?? "1970-01-01");
	const rightTime = Date.parse(right.date ?? "1970-01-01");
	return leftTime - rightTime || left.uid - right.uid;
}

/**
 * Collects thread members, merging mailbox copies that share any identity ID,
 * and tracks which related IDs still need a header search.
 */
class ThreadAssembly {
	private readonly members = new Map<string, ThreadMessage>();
	private readonly memberKeyById = new Map<string, string>();
	private readonly searchedIds = new Set<string>();
	private readonly pendingIds = new Set<string>();

	get size() {
		return this.members.size;
	}

	get hasPendingIds() {
		return this.pendingIds.size > 0;
	}

	takePendingIds() {
		const ids = [...this.pendingIds].slice(
			0,
			THREAD_DISCOVERY_LIMITS.idsPerSearch,
		);
		for (const id of ids) this.pendingIds.delete(id);
		for (const id of ids) this.searchedIds.add(id);
		return ids;
	}

	isRelated(message: ThreadMessage) {
		return relatedIds(message).some((id) => this.searchedIds.has(id));
	}

	add(message: ThreadMessage) {
		const ownIds = threadIdentityIds(message);
		const matchingKeys = new Set(
			ownIds.flatMap((id) => {
				const key = this.memberKeyById.get(id);
				return key ? [key] : [];
			}),
		);
		const memberKey =
			matchingKeys.values().next().value ??
			messageLocation(message.mailbox, message.uid);

		// A copy can reveal aliases or reply links missing from another copy.
		for (const duplicateKey of matchingKeys) {
			if (duplicateKey !== memberKey) this.mergeInto(duplicateKey, memberKey);
		}

		if (!this.members.has(memberKey)) this.members.set(memberKey, message);
		for (const id of ownIds) this.memberKeyById.set(id, memberKey);
		for (const id of relatedIds(message)) {
			if (!this.searchedIds.has(id)) this.pendingIds.add(id);
		}
	}

	addRelated(messages: Iterable<ThreadMessage>) {
		for (const message of messages) {
			if (this.isRelated(message)) this.add(message);
		}
	}

	chronological() {
		return [...this.members.values()].sort(compareChronologically);
	}

	/** Keeps the anchor and the newest other members, in chronological order. */
	newest(anchor: ThreadMessage, limit: number) {
		const members = this.chronological();
		if (members.length <= limit) return members;
		const anchorMember = this.memberOf(anchor);
		const others = members.filter((member) => member !== anchorMember);
		const kept = new Set(others.slice(others.length - (limit - 1)));
		return members.filter(
			(member) => member === anchorMember || kept.has(member),
		);
	}

	private memberOf(message: ThreadMessage) {
		const key =
			threadIdentityIds(message)
				.map((id) => this.memberKeyById.get(id))
				.find((value) => value !== undefined) ??
			messageLocation(message.mailbox, message.uid);
		return this.members.get(key);
	}

	private mergeInto(duplicateKey: string, memberKey: string) {
		this.members.delete(duplicateKey);
		for (const [id, key] of this.memberKeyById) {
			if (key === duplicateKey) this.memberKeyById.set(id, memberKey);
		}
	}
}

/** Remembers every inspected location so each message is fetched only once. */
class ThreadCandidates {
	private readonly accepted = new Map<string, ThreadMessage>();
	private readonly denied = new Set<string>();

	all() {
		return this.accepted.values();
	}

	isKnown(mailbox: string, uid: number) {
		const location = messageLocation(mailbox, uid);
		return this.accepted.has(location) || this.denied.has(location);
	}

	accept(message: ThreadMessage) {
		this.accepted.set(messageLocation(message.mailbox, message.uid), message);
	}

	deny(message: ThreadMessage) {
		this.denied.add(messageLocation(message.mailbox, message.uid));
	}
}

async function searchThreadHeaders(
	client: ImapClient,
	mailbox: string,
	ids: string[],
) {
	const uids = await client.search(
		{ or: ids.flatMap(threadSearchTerms) },
		{ uid: true },
	);
	if (uids === false)
		throw new Error(
			`Proton Bridge could not search thread headers in ${mailbox}. Try again.`,
		);
	return uids;
}

async function collectFromMailbox(
	client: ImapClient,
	mailbox: string,
	frontier: string[],
	thread: ThreadAssembly,
	candidates: ThreadCandidates,
	accepts: MessageFilter,
	budget: DiscoveryBudget,
) {
	if (budget.searches <= 0) return false;
	budget.searches--;
	const selected = await client.mailboxOpen(mailbox, { readOnly: true });
	const uidValidity = selected.uidValidity.toString();
	const uids = await searchThreadHeaders(client, mailbox, frontier);
	const unseen = uids.filter((uid) => !candidates.isKnown(mailbox, uid));

	for (const batch of uidBatches(unseen)) {
		if (budget.candidates <= 0) return false;
		const selectedBatch = batch.slice(0, budget.candidates);
		budget.candidates -= selectedBatch.length;
		const messages = await fetchThreadMessages(
			client,
			mailbox,
			uidValidity,
			selectedBatch,
		);
		for (const message of messages) {
			if (!accepts(mailbox, message)) {
				candidates.deny(message);
				continue;
			}
			candidates.accept(message);
			// HEADER search matches substrings. Traverse only exact parsed IDs.
			thread.addRelated([message]);
		}
		if (selectedBatch.length < batch.length) return false;
	}
	return true;
}

async function expandThread(
	client: ImapClient,
	mailboxes: string[],
	thread: ThreadAssembly,
	candidates: ThreadCandidates,
	accepts: MessageFilter,
) {
	const budget = {
		candidates: THREAD_DISCOVERY_LIMITS.candidates - 1,
		searches: THREAD_DISCOVERY_LIMITS.searches,
	};
	while (thread.hasPendingIds) {
		const frontier = thread.takePendingIds();

		// A substring miss can become related when another message reveals its ID.
		thread.addRelated(candidates.all());

		// One search per mailbox and frontier. Commands share the selected mailbox.
		for (const mailbox of mailboxes) {
			if (
				!(await collectFromMailbox(
					client,
					mailbox,
					frontier,
					thread,
					candidates,
					accepts,
					budget,
				))
			)
				return false;
		}
	}
	return true;
}

function bodyUnavailableReason(result: ReadResult<MessageContent>) {
	switch (result.kind) {
		case "unavailable":
			return result.reason;
		case "found":
			return "Body exceeds the remaining thread limit of 32,000 characters; newer bodies are included first. Use get_message for this body.";
		default:
			return result.kind;
	}
}

/** Spends the text budget on the newest bodies first; output stays chronological. */
async function readThreadBodies(
	client: ImapClient,
	summaries: ThreadMessage[],
	accepts: MessageFilter,
	cache?: MessageCache,
) {
	const messages: ThreadMessageContent[] = [];
	let remainingCharacters = THREAD_BODY_LIMIT;

	for (const message of [...summaries].reverse()) {
		if (remainingCharacters <= 0) {
			messages.push({
				...message,
				bodyStatus: "unavailable",
				reason:
					"Thread body limit of 32,000 characters reached; newer bodies are included first. Use get_message for this body.",
			});
			continue;
		}

		const result = await readMessage(client, message, accepts, cache);
		if (
			result.kind === "found" &&
			result.value.text.length <= remainingCharacters
		) {
			remainingCharacters -= result.value.text.length;
			messages.push({
				...message,
				text: result.value.text,
				bodyStatus: "included",
			});
			continue;
		}

		const reason = bodyUnavailableReason(result);
		messages.push({ ...message, bodyStatus: "unavailable", reason });
	}

	return { messages: messages.reverse() };
}

function withoutBodies(summaries: ThreadMessage[]) {
	return {
		messages: summaries.map((message) => ({
			...message,
			bodyStatus: "not_requested" as const,
		})),
	};
}

type ThreadResult = {
	threadKey: string | undefined;
	limitReached: boolean;
	discoveryComplete: boolean;
	messages: (
		| ThreadMessageContent
		| (ThreadMessage & { bodyStatus: "not_requested" })
	)[];
};

export async function getThread(
	client: ImapClient,
	input: ThreadLookupInput,
	accepts: MessageFilter,
	cache?: MessageCache,
): Promise<ReadResult<ThreadResult>> {
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

	// Discover independently of the response limit before selecting recent members.
	const thread = new ThreadAssembly();
	const candidates = new ThreadCandidates();
	thread.add(anchor);
	candidates.accept(anchor);

	const mailboxes = [...new Set([input.mailbox, ...input.mailboxes])];
	const discoveryComplete = await expandThread(
		client,
		mailboxes,
		thread,
		candidates,
		accepts,
	);

	const summaries = thread.newest(anchor, input.limit);
	const contents = input.includeText
		? await readThreadBodies(client, summaries, accepts, cache)
		: withoutBodies(summaries);
	return {
		kind: "found",
		value: {
			threadKey: anchor.threadKey,
			limitReached: thread.size > input.limit,
			discoveryComplete,
			...contents,
		},
	} as const;
}
