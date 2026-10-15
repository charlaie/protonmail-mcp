import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { isSpecType } from "@modelcontextprotocol/server";
import { createImapService } from "../bridge/imap.js";
import {
	FakeImap,
	fixtureMessage,
	testConfig,
} from "../bridge/test-fixtures.js";
import { createDraftStore } from "../drafts/store.js";
import { testFile, testImage } from "../outgoing/test-fixtures.js";
import { createReadPolicy } from "../policy/schema.js";
import { saveReadPolicy } from "../policy/store.js";
import { ToolNameSchema } from "../policy/tools.js";
import { createSendService } from "../sending/service.js";
import { createSendStore } from "../sending/store.js";
import {
	DraftOperationOutputSchema,
	GetDraftOutputSchema,
	ListDraftOperationsOutputSchema,
	ListSendOperationsOutputSchema,
} from "./output-schemas.js";
import { createServer } from "./server.js";
import { createTestClient } from "./test-client.js";

async function fixture(t: TestContext) {
	const directory = await mkdtemp(join(tmpdir(), "protonmail-draft-tools-"));
	const policyFile = join(directory, "policy.json");
	t.after(async () => {
		await rm(directory, { recursive: true, force: true });
	});
	await saveReadPolicy(
		createReadPolicy({
			bridgeUser: testConfig.user,
			allowedTools: ToolNameSchema.options,
			allowedMailboxes: ["Drafts", "INBOX"],
			allowedSenderEmails: [],
		}),
		policyFile,
	);
	const imapClient = new FakeImap();
	imapClient.mailboxes.set("Drafts", []);
	imapClient.mailboxes.set("INBOX", [fixtureMessage(2)]);
	const imap = createImapService(
		testConfig,
		async (operation) => operation(imapClient),
		createDraftStore(testConfig.user, directory),
	);
	const sends = createSendService(testConfig, {
		store: createSendStore(testConfig.user, directory),
		submit: async () => {
			throw new Error("These tests must never send");
		},
	});
	const client = await createTestClient(t, () =>
		createServer({
			config: testConfig,
			policyFile,
			operationsDirectory: directory,
			imap,
			sends,
		}),
	);
	return {
		...client,
		directory,
		imapClient,
		callTool: async (name: string, args: object) => {
			const result = await client.callTool(name, args);
			assert.ok(isSpecType.CallToolResult(result));
			return result.structuredContent;
		},
	};
}

test("MCP unfinished create, read revision and patch edit use the advertised output contracts", async (t) => {
	const { callTool, imapClient } = await fixture(t);
	const operationId = randomUUID();
	const created = DraftOperationOutputSchema.parse(
		await callTool("create_draft", { operationId }),
	);
	assert.ok("outcome" in created && "identity" in created.outcome);
	assert.equal(created.outcome.status, "completed");
	const draft = GetDraftOutputSchema.parse(
		await callTool("get_draft", created.outcome.identity),
	);
	assert.ok("revision" in draft);
	assert.deepEqual(draft.to, []);
	const input = {
		operationId: randomUUID(),
		uid: draft.uid,
		uidValidity: draft.uidValidity,
		expectedRevision: draft.revision,
		text: "Added body",
		to: ["recipient@example.com"],
	};
	const edited = DraftOperationOutputSchema.parse(
		await callTool("edit_draft", input),
	);
	assert.ok("outcome" in edited && "identity" in edited.outcome);
	assert.equal(edited.outcome.status, "completed");
	const replayed = DraftOperationOutputSchema.parse(
		await callTool("edit_draft", input),
	);
	assert.deepEqual(replayed, edited);
	const updated = GetDraftOutputSchema.parse(
		await callTool("get_draft", edited.outcome.identity),
	);
	assert.ok("text" in updated);
	assert.equal(updated.text.trim(), "Added body");
	assert.deepEqual(updated.to, ["recipient@example.com"]);
	assert.equal(imapClient.appends.length, 2);
});

test("reply draft operation replays after its source disappears without another source read or append", async (t) => {
	const { callTool, imapClient } = await fixture(t);
	const input = {
		operationId: randomUUID(),
		mailbox: "INBOX",
		uid: 2,
		uidValidity: "7",
		text: "Reply",
	};
	const reply = DraftOperationOutputSchema.parse(
		await callTool("create_reply_draft", input),
	);
	assert.ok("outcome" in reply);
	assert.equal(reply.outcome.status, "completed");
	const reads = imapClient.sourceFetches;
	imapClient.mailboxes.set("INBOX", []);
	assert.deepEqual(
		DraftOperationOutputSchema.parse(
			await callTool("create_reply_draft", input),
		),
		reply,
	);
	assert.equal(imapClient.sourceFetches, reads);
	assert.equal(imapClient.appends.length, 1);
});

test("journal metadata remains available during policy outage, pagination ends, and recovery remains policy protected", async (t) => {
	const { callTool, directory, imapClient } = await fixture(t);
	imapClient.deleteFailure = "throw";
	const created = DraftOperationOutputSchema.parse(
		await callTool("create_draft", {
			operationId: randomUUID(),
			to: "recipient@example.com",
		}),
	);
	assert.ok("outcome" in created && "identity" in created.outcome);
	const draft = GetDraftOutputSchema.parse(
		await callTool("get_draft", created.outcome.identity),
	);
	assert.ok("revision" in draft);
	const operationId = randomUUID();
	const edited = DraftOperationOutputSchema.parse(
		await callTool("edit_draft", {
			operationId,
			uid: draft.uid,
			uidValidity: draft.uidValidity,
			expectedRevision: draft.revision,
			text: "Replacement",
		}),
	);
	assert.ok("outcome" in edited);
	assert.equal(edited.outcome.status, "cleanup_failed");
	await rm(join(directory, "policy.json"));
	assert.deepEqual(
		DraftOperationOutputSchema.parse(
			await callTool("get_draft_operation", { operationId }),
		),
		edited,
	);
	const listed = ListDraftOperationsOutputSchema.parse(
		await callTool("list_draft_operations", {}),
	);
	assert.ok("operations" in listed);
	assert.equal(listed.operations.length, 1);
	assert.equal(listed.nextOffset, null);
	assert.equal("requestHash" in listed.operations[0], false);
	assert.equal("text" in listed.operations[0], false);
	const empty = ListDraftOperationsOutputSchema.parse(
		await callTool("list_draft_operations", { offset: 1 }),
	);
	assert.ok("operations" in empty);
	assert.deepEqual(empty.operations, []);
	assert.equal(empty.nextOffset, null);
	const sends = ListSendOperationsOutputSchema.parse(
		await callTool("list_send_operations", {}),
	);
	assert.ok("operations" in sends);
	assert.deepEqual(sends.operations, []);
	const refused = await callTool("retry_draft_cleanup", { operationId });
	assert.match(JSON.stringify(refused), /POLICY_NOT_CONFIGURED/);
	assert.equal(imapClient.deletions, 1);
});

test("reply draft tools accept explicitly supplied files and images and expose manifests without bytes", async (t) => {
	const { callTool, imapClient } = await fixture(t);
	const result = DraftOperationOutputSchema.parse(
		await callTool("create_reply_draft", {
			operationId: randomUUID(),
			mailbox: "INBOX",
			uid: 2,
			uidValidity: "7",
			text: "Reply with files",
			attachments: [testFile],
			inlineImages: [testImage],
		}),
	);
	assert.ok("outcome" in result && "identity" in result.outcome);
	assert.equal(result.outcome.status, "completed");
	assert.equal(result.media?.length, 2);
	const draft = GetDraftOutputSchema.parse(
		await callTool("get_draft", result.outcome.identity),
	);
	assert.ok("revision" in draft);
	assert.equal(draft.media.length, 2);
	assert.equal(
		draft.media.find((part) => part.kind === "attachment")?.filename,
		testFile.filename,
	);
	assert.equal(JSON.stringify(draft).includes("contentBase64"), false);
	assert.equal(imapClient.appends.length, 1);
});
