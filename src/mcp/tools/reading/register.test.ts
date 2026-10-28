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
import { ToolErrorSchema } from "@/shared/mail-error.js";
import { SearchOutputSchema } from "./schemas.js";

async function fixture(t: TestContext) {
	const directory = await mkdtemp(join(tmpdir(), "protonmail-reading-mcp-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const policyFile = join(directory, "policy.json");
	const policy = createReadPolicy({
		bridgeUser: testConfig.user,
		allowedMailboxes: ["INBOX"],
		allowedTools: ["search_messages", "batch_get_messages"],
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
