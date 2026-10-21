import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isSpecType } from "@modelcontextprotocol/server";
import { createImapService } from "@/bridge/imap/service.js";
import { FakeImap, testConfig } from "@/bridge/testing/fixtures.js";
import { createSendService } from "@/mail/sending/service.js";
import { createServer } from "@/mcp/server.js";
import { createSendStore } from "@/operations/sqlite/sending.js";
import { createReadPolicy, ReadPolicySchema } from "@/policy/schema.js";
import { saveReadPolicy } from "@/policy/store.js";
import {
	isPolicyIndependentTool,
	TOOL_DEFINITIONS,
	ToolNameSchema,
} from "@/policy/tools.js";
import { createTestClient } from "./test-client.js";

test("read-only tool visibility rejects direct calls to every mail mutation", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "protonmail-readonly-tools-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const policyFile = join(directory, "policy.json");
	const policy = createReadPolicy({
		bridgeUser: testConfig.user,
		allowedMailboxes: ["INBOX", "Drafts"],
	});
	await saveReadPolicy(policy, policyFile);
	const fake = new FakeImap();
	let submissions = 0;
	const client = await createTestClient(t, () =>
		createServer({
			config: testConfig,
			policyFile,
			operationsDirectory: directory,
			imap: createImapService(testConfig, async (operation) => operation(fake)),
			sends: createSendService(testConfig, {
				store: createSendStore(testConfig.user, directory),
				submit: async () => {
					submissions++;
					return { status: "accepted", accepted: [], rejected: [] };
				},
			}),
		}),
	);
	const listed = await client.request("tools/list", {});
	assert.ok(isSpecType.ListToolsResult(listed.result));
	assert.deepEqual(
		listed.result.tools.map((tool) => tool.name).sort(),
		[...policy.allowedTools].sort(),
	);
	for (const name of Object.keys(TOOL_DEFINITIONS)) {
		if (listed.result.tools.some((tool) => tool.name === name)) continue;
		await assert.rejects(
			client.callTool(name, {}),
			/disabled|not found|Unknown tool/i,
		);
	}
	assert.equal(submissions, 0);
	assert.equal(fake.appends.length, 0);
	assert.equal(fake.deletions, 0);
	assert.equal(fake.moves.length, 0);
	assert.equal(fake.flagChanges.length, 0);
});

test("a revoked tool grant is enforced on a running server before reading Bridge", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "protonmail-revoked-read-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const policyFile = join(directory, "policy.json");
	const policy = createReadPolicy({
		bridgeUser: testConfig.user,
		allowedMailboxes: ["INBOX"],
		allowedTools: ["search_messages"],
	});
	await saveReadPolicy(policy, policyFile);
	const fake = new FakeImap();
	const client = await createTestClient(t, () =>
		createServer({
			config: testConfig,
			policyFile,
			operationsDirectory: directory,
			imap: createImapService(testConfig, async (operation) => operation(fake)),
		}),
	);
	await saveReadPolicy({ ...policy, allowedTools: [] }, policyFile);
	const result = await client.callTool("search_messages", { mailbox: "INBOX" });
	assert.equal(result.isError, true);
	assert.match(JSON.stringify(result), /POLICY_DENIED/);
	assert.equal(fake.searches.length, 0);
});

test("legacy policy cannot grant tools implicitly and only exposes local recovery and discovery", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "protonmail-legacy-grants-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const policyFile = join(directory, "policy.json");
	const legacy = ReadPolicySchema.parse({
		...createReadPolicy({
			bridgeUser: testConfig.user,
			allowedMailboxes: ["INBOX", "Drafts"],
			allowedTools: ToolNameSchema.options,
		}),
		version: 2,
	});
	await saveReadPolicy(legacy, policyFile);
	const fake = new FakeImap();
	const client = await createTestClient(t, () =>
		createServer({
			config: testConfig,
			policyFile,
			operationsDirectory: directory,
			imap: createImapService(testConfig, async (operation) => operation(fake)),
		}),
	);
	const listed = await client.request("tools/list", {});
	assert.ok(isSpecType.ListToolsResult(listed.result));
	assert.deepEqual(
		listed.result.tools.map((tool) => tool.name).sort(),
		ToolNameSchema.options.filter(isPolicyIndependentTool).sort(),
	);
	await assert.rejects(
		client.callTool("create_draft", { operationId: randomUUID() }),
		/disabled|not found|Unknown tool/i,
	);
	await assert.rejects(
		client.callTool("get_message", {
			mailbox: "INBOX",
			uid: 1,
			uidValidity: "7",
		}),
		/disabled|not found|Unknown tool/i,
	);
	assert.equal(fake.appends.length, 0);
	assert.equal(fake.sourceFetches, 0);
});

test("revoking send permission during approval prevents SMTP and preserves the journal", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "protonmail-revoked-send-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const policyFile = join(directory, "policy.json");
	const policy = createReadPolicy({
		bridgeUser: testConfig.user,
		allowedMailboxes: ["INBOX"],
		allowedTools: ["send_email"],
	});
	await saveReadPolicy(policy, policyFile);
	let submissions = 0;
	const store = createSendStore(testConfig.user, directory);
	const client = await createTestClient(
		t,
		() =>
			createServer({
				config: testConfig,
				policyFile,
				operationsDirectory: directory,
				sends: createSendService(testConfig, {
					store,
					submit: async () => {
						submissions++;
						return { status: "accepted", accepted: [], rejected: [] };
					},
				}),
			}),
		{
			capabilities: { elicitation: { form: {} } },
			onElicitation: async () => {
				await saveReadPolicy({ ...policy, allowedTools: [] }, policyFile);
				return { action: "accept", content: { approve_send: true } };
			},
		},
	);
	const operationId = randomUUID();
	const result = await client.callTool("send_email", {
		operationId,
		to: "recipient@example.com",
		subject: "Reviewed",
		text: "Body",
	});
	assert.equal(result.isError, true);
	assert.match(JSON.stringify(result), /POLICY_DENIED/);
	assert.equal(submissions, 0);
	assert.equal((await store.get(operationId))?.outcome.status, "prepared");
});
