import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
	FakeImap,
	fixtureMessage,
	testConfig,
} from "@/bridge/testing/fixtures.js";
import { GetMessageSchema } from "@/mail/identity.js";
import { canReadMessage } from "@/policy/enforcement.js";
import { createReadPolicy } from "@/policy/schema.js";
import { hashContent } from "@/shared/content-hash.js";
import { MailError } from "@/shared/mail-error.js";
import { createSearchCursorCodec, SEARCH_CURSOR_TTL_MS } from "./cursor.js";
import type { allowAllMessages } from "./messages.js";
import { searchMessagePage } from "./pagination.js";
import { SearchMessagesSchema } from "./requests.js";

function fixture() {
	const client = new FakeImap();
	const messages = Array.from({ length: 431 }, (_, index) => ({
		...fixtureMessage(index + 1, {
			sender: index % 7 === 0 ? "denied@example.com" : "trusted@example.com",
		}),
		// Reversed UID/date order, with many equal-date ties spanning page edges.
		internalDate: new Date(Math.floor((431 - index) / 9) * 1000),
	}));
	client.mailboxes.set("INBOX", messages);
	const policy = createReadPolicy({
		bridgeUser: testConfig.user,
		allowedMailboxes: ["INBOX"],
		allowedSenderEmails: ["trusted@example.com"],
	});
	let now = Date.now();
	const context = {
		client,
		cursors: createSearchCursorCodec(() => now),
		account: testConfig.user,
		policyFingerprint: hashContent(policy),
		accepts: (
			mailbox: string,
			message: Parameters<typeof allowAllMessages>[1],
		) => canReadMessage(policy, { mailbox, message }),
	};
	return {
		messages,
		context,
		advance: (milliseconds = SEARCH_CURSOR_TTL_MS) => {
			now += milliseconds;
		},
	};
}

for (const projection of ["summary", "ids"] satisfies ("summary" | "ids")[]) {
	test(`${projection}: every allowed result across >100 messages, received order and equal-date ties`, async () => {
		const { context, messages } = fixture();
		let cursor: string | undefined;
		const actual: number[] = [];
		do {
			const page = await searchMessagePage({
				...context,
				request: SearchMessagesSchema.parse({
					mailbox: "INBOX",
					projection,
					limit: 37,
					cursor,
				}),
			});
			assert.ok(page.messages.length <= 37);
			for (const message of page.messages) {
				GetMessageSchema.parse(message);
				assert.equal(message.mailbox, "INBOX");
				assert.equal(message.uidValidity, "7");
				if (projection === "ids")
					assert.deepEqual(Object.keys(message).sort(), [
						"mailbox",
						"uid",
						"uidValidity",
					]);
			}
			actual.push(...page.messages.map(({ uid }) => uid));
			cursor = page.nextCursor ?? undefined;
			assert.ok(actual.length <= 431, "pagination must terminate");
		} while (cursor);
		const expected = messages
			.filter(
				(message) =>
					message.envelope?.from?.[0]?.address === "trusted@example.com",
			)
			.sort(
				(a, b) =>
					Number(b.internalDate) - Number(a.internalDate) || b.uid - a.uid,
			)
			.map(({ uid }) => uid);
		assert.deepEqual(actual, expected);
		assert.equal(new Set(actual).size, actual.length);
		assert.ok(context.client.fetchBatchSizes.every((size) => size <= 200));
		assert.equal(context.client.sourceFetches, 0);
	});
}

test("opaque cursors bind filters, projection, page size, mailbox, account and policy; tampering fails before SEARCH", async () => {
	const { context } = fixture();
	const request = SearchMessagesSchema.parse({ mailbox: "INBOX", limit: 10 });
	const { nextCursor } = await searchMessagePage({ ...context, request });
	assert.ok(nextCursor);
	const attempts = [
		{ request: { ...request, from: "other@example.com", cursor: nextCursor } },
		{ request: { ...request, to: "other@example.com", cursor: nextCursor } },
		{ request: { ...request, query: "other", cursor: nextCursor } },
		{ request: { ...request, subject: "other", cursor: nextCursor } },
		{ request: { ...request, since: "2026-01-01", cursor: nextCursor } },
		{ request: { ...request, before: "2026-01-01", cursor: nextCursor } },
		{
			request: SearchMessagesSchema.parse({
				...request,
				projection: "ids",
				cursor: nextCursor,
			}),
		},
		{ request: { ...request, limit: 11, cursor: nextCursor } },
		{ request: { ...request, mailbox: "Archive", cursor: nextCursor } },
		{
			request: { ...request, cursor: nextCursor },
			account: "other@example.com",
		},
		{
			request: { ...request, cursor: nextCursor },
			policyFingerprint: "changed",
		},
		{
			request: {
				...request,
				cursor: `${nextCursor.startsWith("A") ? "B" : "A"}${nextCursor.slice(1)}`,
			},
		},
		{ request: { ...request, cursor: "not-a-cursor" } },
		{ request: { ...request, cursor: "a".repeat(2049) } },
		{
			request: { ...request, cursor: nextCursor },
			cursors: createSearchCursorCodec(),
		},
	];
	const searches = context.client.searches.length;
	for (const attempt of attempts) {
		await assert.rejects(
			searchMessagePage({ ...context, ...attempt }),
			(error: unknown) =>
				error instanceof MailError && error.code === "INVALID_INPUT",
		);
	}
	assert.equal(context.client.searches.length, searches);
});

test("expiry is fixed to the first page, and omitting cursor restarts", async () => {
	const { context, advance } = fixture();
	const request = SearchMessagesSchema.parse({ mailbox: "INBOX", limit: 1 });
	const first = await searchMessagePage({ ...context, request });
	assert.ok(first.nextCursor);
	advance(SEARCH_CURSOR_TTL_MS / 2);
	const second = await searchMessagePage({
		...context,
		request: { ...request, cursor: first.nextCursor },
	});
	assert.ok(second.nextCursor);
	advance(SEARCH_CURSOR_TTL_MS / 2);
	await assert.rejects(
		searchMessagePage({
			...context,
			request: { ...request, cursor: second.nextCursor },
		}),
		/expired/,
	);
	const restarted = await searchMessagePage({ ...context, request });
	assert.deepEqual(restarted.messages, first.messages);
});

test("UIDVALIDITY reset requires a restart; later arrivals are excluded and deletions disappear without gaps", async () => {
	const { context, messages } = fixture();
	const request = SearchMessagesSchema.parse({
		mailbox: "INBOX",
		limit: 100,
		projection: "ids",
	});
	const first = await searchMessagePage({ ...context, request });
	assert.ok(first.nextCursor);
	context.client.uidValidity = 8n;
	await assert.rejects(
		searchMessagePage({
			...context,
			request: { ...request, cursor: first.nextCursor },
		}),
		(error: unknown) =>
			error instanceof MailError && error.code === "STALE_IDENTITY",
	);
	context.client.uidValidity = 7n;
	const seen = new Set(first.messages.map(({ uid }) => uid));
	const deleted = messages.find(
		(message) =>
			!seen.has(message.uid) &&
			message.envelope?.from?.[0]?.address === "trusted@example.com",
	);
	assert.ok(deleted);
	context.client.mailboxes.set("INBOX", [
		...messages.filter(
			({ uid }) => uid !== deleted.uid && uid !== first.messages.at(-1)?.uid,
		),
		{ ...fixtureMessage(999), internalDate: new Date(0) },
	]);
	let cursor: string | null = first.nextCursor;
	const rest: number[] = [];
	while (cursor) {
		const page = await searchMessagePage({
			...context,
			request: { ...request, cursor },
		});
		rest.push(...page.messages.map(({ uid }) => uid));
		cursor = page.nextCursor;
	}
	assert.equal(rest.includes(999), false);
	assert.equal(rest.includes(deleted.uid), false);
	assert.equal(
		rest.some((uid) => seen.has(uid)),
		false,
	);
	assert.equal(
		rest.length + first.messages.length,
		messages.filter(
			(message) =>
				message.envelope?.from?.[0]?.address === "trusted@example.com",
		).length - 1,
	);
});

test("all-denied and empty searches have no cursor or denied counts", async () => {
	const { context } = fixture();
	const page = await searchMessagePage({
		...context,
		accepts: () => false,
		request: SearchMessagesSchema.parse({
			mailbox: "INBOX",
			projection: "ids",
		}),
	});
	assert.deepEqual(page, { projection: "ids", messages: [], nextCursor: null });
	context.client.mailboxes.set("INBOX", []);
	assert.deepEqual(
		await searchMessagePage({
			...context,
			request: SearchMessagesSchema.parse({
				mailbox: "INBOX",
				projection: "ids",
			}),
		}),
		page,
	);
});
