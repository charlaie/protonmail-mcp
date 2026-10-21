import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { createImapService } from "@/bridge/imap/service.js";
import {
	FakeImap,
	fixtureMessage,
	testConfig,
} from "@/bridge/testing/fixtures.js";
import { createMailAccess } from "@/mail/access.js";
import { createTestClient } from "@/mcp/integration/test-client.js";
import { createServer } from "@/mcp/server.js";
import { createInboxStore } from "@/operations/sqlite/inbox.js";
import { createReadPolicy, ReadPolicySchema } from "@/policy/schema.js";
import { parseInboxActions } from "@/policy/selection.js";
import { saveReadPolicy } from "@/policy/store.js";
import { ToolNameSchema } from "@/policy/tools.js";
import {
	InboxCapabilitiesOutputSchema,
	InboxOperationOutputSchema,
	InboxOperationsOutputSchema,
} from "./schemas.js";

async function fixture(t: TestContext, enabled = true) {
	const directory = await mkdtemp(join(tmpdir(), "protonmail-inbox-mcp-"));
	const policyFile = join(directory, "policy.json");
	t.after(async () => {
		await rm(directory, { recursive: true, force: true });
	});
	const policy = createReadPolicy({
		bridgeUser: testConfig.user,
		allowedTools: ToolNameSchema.options,
		allowedMailboxes: ["INBOX", "Archive", "Trash", "Labels/Work", "Drafts"],
		allowedSenderEmails: ["trusted@example.com"],
		inboxWrites: enabled
			? {
					mode: "enabled",
					actions: [
						"mark_read",
						"mark_unread",
						"star",
						"archive",
						"trash",
						"apply_label",
						"remove_label",
						"move",
					],
					mailboxes: ["INBOX", "Archive", "Trash", "Labels/Work"],
				}
			: { mode: "disabled" },
	});
	await saveReadPolicy(policy, policyFile);
	const client = new FakeImap();
	const message = fixtureMessage(1);
	message.flags = new Set();
	client.mailboxes.set("INBOX", [message]);
	for (const name of ["Archive", "Trash", "Labels/Work", "Drafts", "Secret"])
		client.mailboxes.set(name, []);
	client.capabilities.set("MOVE", true);
	const imap = createImapService(testConfig, {
		run: async (operation) => operation(client),
		inboxStore: createInboxStore(testConfig.user, directory),
	});
	const mcp = await createTestClient(t, () =>
		createServer({
			config: testConfig,
			policyFile,
			operationsDirectory: directory,
			imap,
		}),
	);
	const input = (action: string) => ({
		operationId: randomUUID(),
		mailbox: "INBOX",
		uid: 1,
		uidValidity: "7",
		change: { action },
	});
	return { directory, policyFile, policy, client, imap, mcp, input };
}

test("existing policies deny inbox writes; invalid write grants cannot expand readable paths", async (t) => {
	const f = await fixture(t, false);
	const { inboxWrites: _, ...oldPolicy } = f.policy;
	const parsed = ReadPolicySchema.parse(oldPolicy);
	assert.equal(parsed.version, 3);
	if (parsed.version !== 3) throw new Error("Expected v3");
	assert.deepEqual(parsed.inboxWrites, { mode: "disabled" });
	assert.throws(
		() =>
			createReadPolicy({
				bridgeUser: testConfig.user,
				allowedTools: ToolNameSchema.options,
				allowedMailboxes: ["INBOX"],
				inboxWrites: {
					mode: "enabled",
					actions: ["move"],
					mailboxes: ["INBOX", "Secret"],
				},
			}),
		/also be allowed/,
	);
	assert.deepEqual(parseInboxActions("star,mark_read,star"), [
		"star",
		"mark_read",
	]);
	assert.throws(() => parseInboxActions("delete_permanently"));
	const response = await f.mcp.callTool("manage_message", f.input("star"));
	assert.equal(response.isError, true);
	assert.match(JSON.stringify(response.structuredContent), /disabled/);
	assert.equal(f.client.flagChanges.length, 0);
});

test("MCP capabilities, inbox mutations, and journal tools satisfy advertised contracts", async (t) => {
	const f = await fixture(t);
	const capabilities = InboxCapabilitiesOutputSchema.parse(
		(await f.mcp.callTool("get_inbox_capabilities", {})).structuredContent,
	);
	assert.ok("nativeMoveSupported" in capabilities);
	assert.equal(capabilities.nativeMoveSupported, true);
	assert.equal(
		capabilities.mailboxes.some((mailbox) => mailbox.path === "Secret"),
		false,
	);
	assert.equal(
		capabilities.mailboxes.find((mailbox) => mailbox.path === "Drafts")
			?.writable,
		false,
	);
	const input = f.input("mark_read");
	const record = InboxOperationOutputSchema.parse(
		(await f.mcp.callTool("manage_message", input)).structuredContent,
	);
	assert.ok("outcome" in record);
	assert.equal(record.outcome.status, "completed");
	assert.equal("requestHash" in record, false);
	assert.deepEqual(
		(await f.mcp.callTool("manage_message", input)).structuredContent,
		record,
	);
	assert.equal(f.client.flagChanges.length, 1);
	await unlink(f.policyFile);
	assert.deepEqual(
		(
			await f.mcp.callTool("get_inbox_operation", {
				operationId: input.operationId,
			})
		).structuredContent,
		record,
	);
	const operations = InboxOperationsOutputSchema.parse(
		(await f.mcp.callTool("list_inbox_operations", {})).structuredContent,
	);
	assert.ok("operations" in operations);
	assert.deepEqual(operations.operations, []);
	assert.equal(operations.nextOffset, null);
});

test("action, source, destination and sender policy are enforced before external mutations", async (t) => {
	const f = await fixture(t);
	await saveReadPolicy(
		createReadPolicy({
			bridgeUser: testConfig.user,
			allowedTools: ToolNameSchema.options,
			allowedMailboxes: ["INBOX", "Archive"],
			inboxWrites: {
				mode: "enabled",
				actions: ["archive"],
				mailboxes: ["INBOX"],
			},
		}),
		f.policyFile,
	);
	const denied = await f.mcp.callTool("manage_message", f.input("archive"));
	assert.equal(denied.isError, true);
	assert.match(
		JSON.stringify(denied.structuredContent),
		/read and inbox write/,
	);
	assert.equal(
		(await f.mcp.callTool("manage_message", f.input("star"))).isError,
		true,
	);
	await saveReadPolicy(
		createReadPolicy({
			bridgeUser: testConfig.user,
			allowedTools: ToolNameSchema.options,
			allowedMailboxes: ["INBOX", "Archive"],
			allowedSenderEmails: ["someone-else@example.com"],
			inboxWrites: {
				mode: "enabled",
				actions: ["archive"],
				mailboxes: ["INBOX", "Archive"],
			},
		}),
		f.policyFile,
	);
	assert.equal(
		(await f.mcp.callTool("manage_message", f.input("archive"))).isError,
		true,
	);
	assert.equal(f.client.moves.length + f.client.flagChanges.length, 0);
	assert.equal(f.client.sourceFetches, 0);
	const mail = await createMailAccess(
		f.imap,
		"bridge@example.com",
		f.policyFile,
	);
	await assert.rejects(
		mail.manageInbox({
			...f.input("archive"),
			mailbox: "Secret",
			change: { action: "archive" },
		}),
		/not selectable|permission/,
	);
});

test("policy reload during an inbox action revokes write permission before STORE", async (t) => {
	const f = await fixture(t);
	let opens = 0;
	const original = f.client.mailboxOpen.bind(f.client);
	f.client.mailboxOpen = async (...args) => {
		const result = await original(...args);
		if (++opens === 1)
			await saveReadPolicy(
				{ ...f.policy, inboxWrites: { mode: "disabled" } },
				f.policyFile,
			);
		return result;
	};
	const response = await f.mcp.callTool("manage_message", f.input("star"));
	assert.equal(response.isError, true);
	assert.equal(f.client.flagChanges.length, 0);
	assert.match(JSON.stringify(response.structuredContent), /disabled/);
	const aborted = InboxOperationOutputSchema.parse(response.structuredContent);
	assert.ok("outcome" in aborted);
	assert.equal(aborted.outcome.status, "aborted");
	assert.equal(aborted.retry, "never");
	const listed = InboxOperationsOutputSchema.parse(
		(await f.mcp.callTool("list_inbox_operations", {})).structuredContent,
	);
	assert.ok("operations" in listed);
	assert.deepEqual(listed.operations, []);
	await saveReadPolicy(f.policy, f.policyFile);
	assert.deepEqual(
		(await f.mcp.callTool("manage_message", aborted.request)).structuredContent,
		aborted,
	);
	const next = InboxOperationOutputSchema.parse(
		(await f.mcp.callTool("manage_message", f.input("mark_read")))
			.structuredContent,
	);
	assert.ok("outcome" in next);
	assert.equal(next.outcome.status, "completed");
	assert.equal(f.client.flagChanges.length, 1);
});
