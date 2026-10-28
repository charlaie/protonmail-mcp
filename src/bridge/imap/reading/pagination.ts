import type { FetchMessageObject } from "imapflow";
import { z } from "zod";
import {
	messageReceivedTime,
	messageSummary,
} from "@/bridge/imap/serializers.js";
import type { ImapClient } from "@/bridge/imap/session.js";
import { GetMessageSchema } from "@/mail/identity.js";
import { MessageSummarySchema } from "@/mail/message.js";
import { hashContent } from "@/shared/content-hash.js";
import {
	SEARCH_CURSOR_TTL_MS,
	type SearchCursorCodec,
	type SearchPosition,
} from "./cursor.js";
import {
	checkUidValidity,
	type MessageFilter,
	SUMMARY_FIELDS,
	uidBatches,
} from "./messages.js";
import type { SearchMessagesInput } from "./requests.js";
import { buildSearchQuery } from "./search.js";

const pageFields = { nextCursor: z.string().nullable() };
export const SearchPageSchema = z.discriminatedUnion("projection", [
	z.object({
		...pageFields,
		projection: z.literal("summary"),
		messages: z.array(
			MessageSummarySchema.extend({ mailbox: GetMessageSchema.shape.mailbox }),
		),
	}),
	z.object({
		...pageFields,
		projection: z.literal("ids"),
		messages: z.array(GetMessageSchema),
	}),
]);
export type SearchPage = z.infer<typeof SearchPageSchema>;

function position(message: FetchMessageObject): SearchPosition {
	return { time: messageReceivedTime(message), uid: message.uid };
}
function compare(left: SearchPosition, right: SearchPosition) {
	return right.time - left.time || right.uid - left.uid;
}

/** Re-scan current matches, retaining only one page plus lookahead in received order. */
export async function searchMessagePage(input: {
	client: ImapClient;
	request: SearchMessagesInput;
	accepts: MessageFilter;
	account: string;
	policyFingerprint: string;
	cursors: SearchCursorCodec;
}): Promise<SearchPage> {
	const { client, request, accepts, cursors } = input;
	const binding = hashContent({
		account: input.account,
		policy: input.policyFingerprint,
		mailbox: request.mailbox,
		query: buildSearchQuery(request),
		projection: request.projection,
		limit: request.limit,
	});
	const cursor =
		request.cursor === undefined
			? undefined
			: cursors.decode({ token: request.cursor, binding });
	const mailbox = await client.mailboxOpen(request.mailbox, { readOnly: true });
	checkUidValidity(cursor?.uidValidity, mailbox.uidValidity);
	const uidValidity = mailbox.uidValidity.toString();
	const ceiling = cursor?.ceiling ?? mailbox.uidNext - 1;
	const expiresAt = cursor?.expiresAt ?? cursors.now() + SEARCH_CURSOR_TTL_MS;
	const uids = await client.search(buildSearchQuery(request), { uid: true });
	if (uids === false)
		throw new Error(
			"Proton Bridge could not complete the message search. Try again.",
		);
	let newest: FetchMessageObject[] = [];
	for (const batch of uidBatches(uids.filter((uid) => uid <= ceiling))) {
		const fetched = await client.fetchAll(batch, SUMMARY_FIELDS, { uid: true });
		const accepted = fetched.filter(
			(message) =>
				message.uid <= ceiling &&
				(cursor === undefined ||
					compare(position(message), cursor.after) > 0) &&
				accepts(request.mailbox, messageSummary(message, uidValidity)),
		);
		newest = [...newest, ...accepted]
			.sort((left, right) => compare(position(left), position(right)))
			.slice(0, request.limit + 1);
	}
	const page = newest.slice(0, request.limit);
	const last = page.at(-1);
	const nextCursor =
		newest.length > request.limit && last
			? cursors.encode({
					version: 1,
					binding,
					uidValidity,
					ceiling,
					expiresAt,
					after: position(last),
				})
			: null;
	if (request.projection === "ids")
		return {
			projection: "ids",
			nextCursor,
			messages: page.map(({ uid }) => ({
				mailbox: request.mailbox,
				uid,
				uidValidity,
			})),
		};
	return {
		projection: "summary",
		nextCursor,
		messages: page.map((message) => ({
			mailbox: request.mailbox,
			...messageSummary(message, uidValidity),
		})),
	};
}
