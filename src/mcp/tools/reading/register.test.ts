import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { isSpecType } from "@modelcontextprotocol/server";
import { createImapService } from "@/bridge/imap/service.js";
import {
	FakeImap,
	fixtureMessage,
	testConfig,
} from "@/bridge/testing/fixtures.js";
import { BatchReadSchema } from "@/mail/reading/batch.js";
import { createTestClient } from "@/mcp/integration/test-client.js";
import { createServer } from "@/mcp/server.js";
import { createReadPolicy } from "@/policy/schema.js";
import { saveReadPolicy } from "@/policy/store.js";
import type { ToolName } from "@/policy/tools.js";
import { ToolErrorSchema } from "@/shared/mail-error.js";
import {
	GetMessageOutputSchema,
	MailboxesOutputSchema,
	SearchOutputSchema,
	ThreadOutputSchema,
} from "./schemas.js";

async function fixture(
	t: TestContext,
	allowedTools: ToolName[] = ["search_messages", "batch_get_messages"],
) {
	const directory = await mkdtemp(join(tmpdir(), "protonmail-reading-mcp-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const policyFile = join(directory, "policy.json");
	const policy = createReadPolicy({
		bridgeUser: testConfig.user,
		allowedMailboxes: ["INBOX"],
		allowedTools,
		allowedSenderEmails: ["trusted@example.com"],
	});
	await saveReadPolicy(policy, policyFile);
	const fake = new FakeImap();
	fake.mailboxes.set(
		"INBOX",
		Array.from({ length: 151 }, (_, index) => fixtureMessage(index + 1)),
	);
	const imap = createImapService(testConfig, {
		run: async (operation) => operation(fake),
	});
	const client = await createTestClient(t, () =>
		createServer({
			config: testConfig,
			policyFile,
			operationsDirectory: directory,
			imap,
		}),
	);
	return { client, fake, policy, policyFile };
}

test("MCP pages identities directly into ordered batch reads with only those tool grants", async (t) => {
	const { client, fake } = await fixture(t);
	const firstResult = await client.callTool("search_messages", {
		mailbox: "INBOX",
		projection: "ids",
		limit: 100,
	});
	assert.ok(isSpecType.CallToolResult(firstResult));
	assert.equal(firstResult.isError, undefined);
	const first = SearchOutputSchema.parse(firstResult.structuredContent);
	assert.ok(first.status === "ok" && first.projection === "ids");
	assert.equal(first.messages.length, 100);
	assert.ok(first.nextCursor);
	const nextResult = await client.callTool("search_messages", {
		mailbox: "INBOX",
		projection: "ids",
		limit: 100,
		cursor: first.nextCursor,
	});
	assert.ok(isSpecType.CallToolResult(nextResult));
	const next = SearchOutputSchema.parse(nextResult.structuredContent);
	assert.ok(next.status === "ok");
	assert.equal(next.messages.length, 51);
	assert.equal(next.nextCursor, null);
	assert.equal(
		new Set([...first.messages, ...next.messages].map(({ uid }) => uid)).size,
		151,
	);
	assert.equal(fake.sourceFetches, 0);
	const reference = first.messages[0];
	assert.ok(reference);
	const batchResult = await client.callTool("batch_get_messages", {
		messages: [
			reference,
			{ ...reference, uid: 999 },
			{ ...reference, mailbox: "Denied" },
			{ ...reference, uidValidity: "8" },
			reference,
		],
	});
	assert.ok(isSpecType.CallToolResult(batchResult));
	assert.equal(batchResult.isError, undefined);
	const batch = BatchReadSchema.parse(batchResult.structuredContent);
	assert.deepEqual(
		batch.items.map(({ kind }) => kind),
		["found", "not_found", "denied", "stale_identity", "found"],
	);
	assert.equal(fake.appends.length, 0);
	assert.equal(fake.downloads.length, 0);
});

test("new mail-access instances reject old cursors after policy edits and authorize current IDs-only policy", async (t) => {
	const { client, fake, policy, policyFile } = await fixture(t);
	const response = await client.callTool("search_messages", {
		mailbox: "INBOX",
		projection: "ids",
		limit: 2,
	});
	assert.ok(isSpecType.CallToolResult(response));
	const first = SearchOutputSchema.parse(response.structuredContent);
	assert.ok(first.status === "ok" && first.nextCursor);
	await saveReadPolicy(
		{ ...policy, allowedSenderEmails: ["different@example.com"] },
		policyFile,
	);
	const searches = fake.searches.length;
	const stale = await client.callTool("search_messages", {
		mailbox: "INBOX",
		projection: "ids",
		limit: 2,
		cursor: first.nextCursor,
	});
	assert.ok(isSpecType.CallToolResult(stale));
	assert.equal(stale.isError, true);
	assert.equal(
		ToolErrorSchema.parse(stale.structuredContent).error.code,
		"INVALID_INPUT",
	);
	assert.equal(fake.searches.length, searches);
	const fresh = await client.callTool("search_messages", {
		mailbox: "INBOX",
		projection: "ids",
		limit: 2,
	});
	assert.ok(isSpecType.CallToolResult(fresh));
	assert.deepEqual(SearchOutputSchema.parse(fresh.structuredContent), {
		status: "ok",
		projection: "ids",
		messages: [],
		nextCursor: null,
	});
	const deniedRead = await client.callTool("batch_get_messages", {
		messages: [{ mailbox: "INBOX", uid: 151, uidValidity: "7" }],
	});
	assert.ok(isSpecType.CallToolResult(deniedRead));
	assert.equal(deniedRead.isError, undefined);
	assert.equal(
		BatchReadSchema.parse(deniedRead.structuredContent).items[0]?.kind,
		"denied",
	);
	assert.equal(fake.sourceFetches, 0);
	await saveReadPolicy({ ...policy, allowedTools: [] }, policyFile);
	const revoked = await client.callTool("batch_get_messages", {
		messages: [{ mailbox: "INBOX", uid: 151, uidValidity: "7" }],
	});
	assert.ok(isSpecType.CallToolResult(revoked));
	assert.equal(revoked.isError, true);
	assert.equal(
		ToolErrorSchema.parse(revoked.structuredContent).error.code,
		"POLICY_DENIED",
	);
});

test("batch input validation is an outer error before Bridge reads", async (t) => {
	const { client, fake } = await fixture(t);
	for (const messages of [
		[],
		[{ mailbox: "INBOX", uid: 1 }],
		Array.from({ length: 21 }, () => ({
			mailbox: "INBOX",
			uid: 1,
			uidValidity: "7",
		})),
	]) {
		const result = await client.callTool("batch_get_messages", { messages });
		assert.ok(isSpecType.CallToolResult(result));
		assert.equal(result.isError, true);
	}
	assert.equal(fake.sourceFetches, 0);
});

test("message body pages are bounded, preserve Unicode, and can reconstruct the full text", async (t) => {
	const { client, fake } = await fixture(t, ["get_message"]);
	const text = `${"a".repeat(3999)}😀${"b".repeat(17000)}`;
	fake.mailboxes.set("INBOX", [fixtureMessage(1, { text })]);
	const identity = { mailbox: "INBOX", uid: 1, uidValidity: "7" };
	const parts: string[] = [];
	let offset = 0;
	do {
		const result = await client.callTool("get_message", {
			...identity,
			textOffset: offset,
		});
		assert.ok(isSpecType.CallToolResult(result));
		const page = GetMessageOutputSchema.parse(result.structuredContent);
		assert.ok(!("status" in page));
		assert.equal(page.textPage.offset, offset);
		assert.equal(page.textPage.totalChars, text.length);
		assert.ok(page.text.length <= 4000);
		assert.equal(Buffer.from(page.text).toString("utf8"), page.text);
		parts.push(page.text);
		if (page.textPage.nextOffset === null) break;
		assert.ok(page.textPage.nextOffset > offset);
		offset = page.textPage.nextOffset;
	} while (offset < text.length);
	assert.equal(parts.join(""), text);
	for (const args of [
		{ textOffset: text.length + 1 },
		{ textOffset: 4000 },
		{ textLimit: 16001 },
		{ textOffset: -1 },
	]) {
		const result = await client.callTool("get_message", {
			...identity,
			...args,
		});
		assert.equal(result.isError, true);
	}
	const end = await client.callTool("get_message", {
		...identity,
		textOffset: text.length,
	});
	assert.ok(isSpecType.CallToolResult(end));
	const page = GetMessageOutputSchema.parse(end.structuredContent);
	assert.ok(!("status" in page));
	assert.equal(page.text, "");
	assert.equal(page.textPage.nextOffset, null);
});

test("search and thread defaults return ten summaries without fetching bodies", async (t) => {
	const { client, fake } = await fixture(t, ["search_messages", "get_thread"]);
	fake.mailboxes.set(
		"INBOX",
		Array.from({ length: 15 }, (_, i) =>
			fixtureMessage(i + 1, {
				references: i ? ["<message-1@example.com>"] : [],
			}),
		),
	);
	const search = await client.callTool("search_messages", { mailbox: "INBOX" });
	assert.ok(isSpecType.CallToolResult(search));
	const page = SearchOutputSchema.parse(search.structuredContent);
	assert.ok(page.status === "ok");
	assert.equal(page.messages.length, 10);
	assert.ok(page.nextCursor);
	const thread = await client.callTool("get_thread", {
		mailbox: "INBOX",
		uid: 1,
		uidValidity: "7",
	});
	assert.ok(isSpecType.CallToolResult(thread));
	const result = ThreadOutputSchema.parse(thread.structuredContent);
	assert.equal(result.status, "ok");
	assert.ok("messages" in result);
	assert.equal(result.messages.length, 10);
	assert.equal(result.limitReached, true);
	assert.ok(
		result.messages.every(
			(message) =>
				message.bodyStatus === "not_requested" && !("text" in message),
		),
	);
	assert.equal(fake.sourceFetches, 0);
});

test("body paging handles empty text, explicit page sizes, and access changes between pages", async (t) => {
	const { client, fake, policy, policyFile } = await fixture(t, [
		"get_message",
	]);
	fake.mailboxes.set("INBOX", [
		fixtureMessage(1, { text: "" }),
		fixtureMessage(2, { text: "x".repeat(20_000) }),
	]);
	const identity = { mailbox: "INBOX", uidValidity: "7" };
	const emptyResult = await client.callTool("get_message", {
		...identity,
		uid: 1,
	});
	assert.ok(isSpecType.CallToolResult(emptyResult));
	const empty = GetMessageOutputSchema.parse(emptyResult.structuredContent);
	assert.ok(!("status" in empty));
	assert.equal(empty.text, "");
	assert.deepEqual(empty.textPage, {
		offset: 0,
		totalChars: 0,
		nextOffset: null,
	});
	const result = await client.callTool("get_message", {
		...identity,
		uid: 2,
		textLimit: 16_000,
	});
	assert.ok(isSpecType.CallToolResult(result));
	const page = GetMessageOutputSchema.parse(result.structuredContent);
	assert.ok(!("status" in page));
	assert.equal(page.text.length, 16_000);
	assert.equal(page.textPage.nextOffset, 16_000);
	await saveReadPolicy(
		{ ...policy, allowedSenderEmails: ["different@example.com"] },
		policyFile,
	);
	const reads = fake.sourceFetches;
	const denied = await client.callTool("get_message", {
		...identity,
		uid: 2,
		textOffset: page.textPage.nextOffset,
	});
	assert.ok(isSpecType.CallToolResult(denied));
	assert.equal(denied.isError, true);
	assert.equal(
		ToolErrorSchema.parse(denied.structuredContent).error.code,
		"POLICY_DENIED",
	);
	assert.equal(fake.sourceFetches, reads);
});

test("minimum body pages make progress through surrogate pairs", async (t) => {
	const { client, fake } = await fixture(t, ["get_message"]);
	const text = `a${"😀".repeat(5)}b`;
	fake.mailboxes.set("INBOX", [fixtureMessage(1, { text })]);
	const parts: string[] = [];
	let offset: number | null = 0;
	while (offset !== null) {
		const result = await client.callTool("get_message", {
			mailbox: "INBOX",
			uid: 1,
			uidValidity: "7",
			textOffset: offset,
			textLimit: 2,
		});
		const page = GetMessageOutputSchema.parse(result.structuredContent);
		assert.ok(!("status" in page));
		assert.ok(page.text.length > 0);
		parts.push(page.text);
		offset = page.textPage.nextOffset;
	}
	assert.equal(parts.join(""), text);
});

test("get_message caps repeated metadata on every page", async (t) => {
	const { client, fake } = await fixture(t, ["get_message"]);
	const message = fixtureMessage(1, {
		text: "x".repeat(10_000),
		references: Array.from(
			{ length: 200 },
			(_, index) => `<ref-${index}-${"r".repeat(40)}@example.com>`,
		),
	});
	assert.ok(message.envelope);
	message.envelope.to = Array.from({ length: 500 }, (_, index) => ({
		name: "n".repeat(500),
		address: `recipient-${index}@example.com`,
	}));
	fake.mailboxes.set("INBOX", [message]);
	for (const textOffset of [0, 4_000]) {
		const result = await client.callTool("get_message", {
			mailbox: "INBOX",
			uid: 1,
			uidValidity: "7",
			textOffset,
		});
		assert.ok(isSpecType.CallToolResult(result));
		const page = GetMessageOutputSchema.parse(result.structuredContent);
		assert.ok(!("status" in page));
		assert.equal(page.to.length, 20);
		assert.ok(page.to.every((entry) => entry.length <= 320));
		assert.equal(page.references.length, 10);
		assert.deepEqual(page.omitted, { to: 480, references: 190 });
		const content = result.content?.[0];
		assert.ok(content?.type === "text");
		assert.ok(Buffer.byteLength(content.text) < 16_384);
	}
});

test("thread limits keep the requested message and the newest others, and report omissions accurately", async (t) => {
	const { client, fake } = await fixture(t, ["get_thread"]);
	const replies = (count: number) =>
		Array.from({ length: count }, (_, i) =>
			fixtureMessage(i + 1, {
				references: i ? ["<message-1@example.com>"] : [],
			}),
		);
	const thread = async (limit: number) => {
		const result = await client.callTool("get_thread", {
			mailbox: "INBOX",
			uid: 1,
			uidValidity: "7",
			limit,
		});
		const parsed = ThreadOutputSchema.parse(result.structuredContent);
		assert.ok("messages" in parsed);
		return parsed;
	};
	fake.mailboxes.set("INBOX", replies(6));
	const limited = await thread(3);
	assert.deepEqual(
		limited.messages.map((message) => message.uid),
		[1, 5, 6],
	);
	assert.equal(limited.limitReached, true);
	fake.mailboxes.set("INBOX", replies(3));
	const exact = await thread(3);
	assert.equal(exact.messages.length, 3);
	assert.equal(exact.limitReached, false);
});

test("thread bodies spend the text budget on the newest messages first", async (t) => {
	const { client, fake } = await fixture(t, ["get_thread"]);
	fake.mailboxes.set(
		"INBOX",
		["a", "b", "c"].map((letter, i) =>
			fixtureMessage(i + 1, {
				references: i ? ["<message-1@example.com>"] : [],
				text: letter.repeat(20_000),
			}),
		),
	);
	const result = await client.callTool("get_thread", {
		mailbox: "INBOX",
		uid: 1,
		uidValidity: "7",
		includeText: true,
	});
	const parsed = ThreadOutputSchema.parse(result.structuredContent);
	assert.ok("messages" in parsed);
	assert.deepEqual(
		parsed.messages.map((message) => [message.uid, message.bodyStatus]),
		[
			[1, "unavailable"],
			[2, "unavailable"],
			[3, "included"],
		],
	);
	const newest = parsed.messages[2];
	assert.ok(newest?.bodyStatus === "included");
	assert.equal(newest.text, "c".repeat(20_000));
	assert.equal("headers" in newest, false);
});

test("message pages reuse parsed content but recheck policy, flags, existence and UIDVALIDITY", async (t) => {
	const { client, fake } = await fixture(t, ["get_message"]);
	const message = fixtureMessage(1, { text: "x".repeat(8000) });
	fake.mailboxes.set("INBOX", [message]);
	const identity = { mailbox: "INBOX", uid: 1, uidValidity: "7" };
	await client.callTool("get_message", identity);
	assert.equal(fake.sourceFetches, 1);
	message.flags?.add("\\Seen");
	const response = await client.callTool("get_message", {
		...identity,
		textOffset: 4000,
	});
	assert.ok(isSpecType.CallToolResult(response));
	const result = GetMessageOutputSchema.parse(response.structuredContent);
	assert.ok("textPage" in result);
	assert.ok(result.flags.includes("\\Seen"));
	assert.equal(result.textPage.offset, 4000);
	assert.equal(fake.sourceFetches, 1);
	fake.mailboxes.set("INBOX", []);
	const removed = await client.callTool("get_message", identity);
	assert.ok(isSpecType.CallToolResult(removed));
	assert.equal(
		ToolErrorSchema.parse(removed.structuredContent).error.code,
		"NOT_FOUND",
	);
	fake.mailboxes.set("INBOX", [message]);
	fake.uidValidity = 8n;
	const stale = await client.callTool("get_message", identity);
	assert.ok(isSpecType.CallToolResult(stale));
	assert.equal(
		ToolErrorSchema.parse(stale.structuredContent).error.code,
		"STALE_IDENTITY",
	);
	assert.equal(fake.sourceFetches, 1);
});

test("mailbox lists paginate exact paths", async (t) => {
	const { client, fake } = await fixture(t, ["list_mailboxes"]);
	fake.mailboxes.clear();
	for (let i = 0; i < 45; i++)
		fake.mailboxes.set(`Folders/Box-${String(i).padStart(2, "0")}`, []);
	const paths: string[] = [];
	let offset = 0;
	do {
		const response = await client.callTool("list_mailboxes", { offset });
		assert.ok(isSpecType.CallToolResult(response));
		const result = MailboxesOutputSchema.parse(response.structuredContent);
		assert.ok("mailboxes" in result);
		assert.ok(result.mailboxes.length <= 20);
		paths.push(...result.mailboxes.map((mailbox) => mailbox.path));
		if (result.nextOffset === null) break;
		offset = result.nextOffset;
	} while (offset < 45);
	assert.deepEqual(paths, [...fake.mailboxes.keys()].sort());
});
