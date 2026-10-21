import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { isSpecType } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createImapService } from "../../bridge/imap/service.js";
import {
	FakeImap,
	fixtureMessage,
	testConfig,
} from "../../bridge/testing/fixtures.js";
import type { OutgoingMessage } from "../../mail/outgoing/message.js";
import { createSendService } from "../../mail/sending/service.js";
import { createDraftStore } from "../../operations/sqlite/drafts.js";
import { createSendStore } from "../../operations/sqlite/sending.js";
import { createReadPolicy } from "../../policy/schema.js";
import { saveReadPolicy } from "../../policy/store.js";
import { ToolNameSchema } from "../../policy/tools.js";
import { createApprovalController } from "../protocol/elicitation.js";
import { createServer } from "../server.js";
import {
	DraftOperationOutputSchema,
	GetDraftOutputSchema,
} from "../tools/drafts/schemas.js";
import { SendOutputSchema } from "../tools/sending/schemas.js";
import { createTestClient } from "./test-client.js";

const alias = "work@example.com";
const config = {
	...testConfig,
	ownAddresses: [...testConfig.ownAddresses, alias],
};
const sourceIdentity = { mailbox: "INBOX", uid: 1, uidValidity: "7" };
const approved = {
	inputResponses: {
		approve_send: { action: "accept", content: { approve_send: true } },
	},
};
const continuationSchema = z.object({
	resultType: z.literal("input_required"),
	requestState: z.string(),
});

async function fixture(t: TestContext) {
	const directory = await mkdtemp(join(tmpdir(), "protonmail-senders-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const policyFile = join(directory, "policy.json");
	await saveReadPolicy(
		createReadPolicy({
			bridgeUser: config.user,
			allowedTools: ToolNameSchema.options,
			allowedMailboxes: ["INBOX", "Drafts"],
			allowedSenderEmails: [],
		}),
		policyFile,
	);
	const imapClient = new FakeImap();
	const source = fixtureMessage(1);
	source.source = Buffer.from(
		`From: author@example.com\r\nTo: ${alias}\r\nSubject: Question\r\nMessage-ID: <question@example.com>\r\n\r\nOriginal body`,
	);
	source.size = source.source.length;
	imapClient.mailboxes.set("INBOX", [source]);
	imapClient.mailboxes.set("Drafts", []);
	const imap = createImapService(config, {
		run: async (operation) => operation(imapClient),
		draftStore: createDraftStore(config.user, directory),
	});
	const submissions: OutgoingMessage[] = [];
	const sends = createSendService(config, {
		store: createSendStore(config.user, directory),
		submit: async (message) => {
			submissions.push(message);
			return { status: "accepted", accepted: message.to, rejected: [] };
		},
	});
	const approval = createApprovalController();
	const client = await createTestClient(
		t,
		() => createServer({ config, imap, sends, policyFile, approval }),
		{
			protocolVersion: "2026-07-28",
			capabilities: { elicitation: { form: {} } },
		},
	);
	async function callTool(name: string, args: object) {
		const result = await client.callTool(name, args);
		assert.ok(isSpecType.CallToolResult(result));
		return result.structuredContent;
	}
	return { client, callTool, imapClient, submissions };
}

test("composition schemas advertise only configured sender choices", async (t) => {
	const { client } = await fixture(t);
	const listed = z
		.object({
			tools: z.array(z.object({ name: z.string(), inputSchema: z.unknown() })),
		})
		.parse((await client.request("tools/list", {})).result);
	for (const name of [
		"send_email",
		"forward_email",
		"create_draft",
		"create_reply_draft",
	]) {
		const schema = z
			.object({
				properties: z.object({ from: z.object({ enum: z.array(z.string()) }) }),
			})
			.parse(listed.tools.find((tool) => tool.name === name)?.inputSchema);
		assert.deepEqual(schema.properties.from.enum, config.ownAddresses);
	}
	assert.equal(JSON.stringify(listed).includes(config.password), false);
});

for (const name of ["send_email", "forward_email"]) {
	test(`${name} approves the selected sender, keeps the default, and never resends a replay`, async (t) => {
		const { client, callTool, submissions } = await fixture(t);
		for (const from of [undefined, alias]) {
			const args = {
				operationId: randomUUID(),
				...(from ? { from } : {}),
				...(name === "forward_email" ? { source: sourceIdentity } : {}),
				to: "recipient@example.com",
				subject: "Topic",
				text: "Body",
			};
			const response = await client.callTool(name, args);
			assert.ok(
				JSON.stringify(response).includes(`From: ${from ?? config.user}`),
			);
			const pending = continuationSchema.parse(response);
			const before = submissions.length;
			const sent = await client.callTool(name, args, {
				...approved,
				requestState: pending.requestState,
			});
			assert.ok(isSpecType.CallToolResult(sent));
			const result = SendOutputSchema.parse(sent.structuredContent);
			assert.ok("outcome" in result);
			assert.equal(result.outcome.status, "accepted");
			assert.equal(submissions.length, before + 1);
			assert.equal(submissions.at(-1)?.from, from ?? config.user);
			assert.deepEqual(await callTool(name, args), result);
			assert.equal(submissions.length, before + 1);
		}
	});
}

test("changing the sender cannot reuse an operation or its approval", async (t) => {
	const { client, callTool, submissions } = await fixture(t);
	const args = {
		operationId: randomUUID(),
		from: alias,
		to: "recipient@example.com",
		subject: "Topic",
		text: "Body",
	};
	const pending = continuationSchema.parse(
		await client.callTool("send_email", args),
	);
	const changed = await client.callTool(
		"send_email",
		{ ...args, from: config.user },
		{ ...approved, requestState: pending.requestState },
	);
	assert.match(JSON.stringify(changed), /OPERATION_CONFLICT/);
	assert.equal(submissions.length, 0);
	const sent = await client.callTool("send_email", args, {
		...approved,
		requestState: pending.requestState,
	});
	assert.ok(isSpecType.CallToolResult(sent));
	const result = SendOutputSchema.parse(sent.structuredContent);
	assert.ok("outcome" in result);
	assert.equal(result.outcome.status, "accepted");
	assert.equal(submissions.at(-1)?.from, alias);
	assert.match(
		JSON.stringify(
			await callTool("send_email", { ...args, from: config.user }),
		),
		/OPERATION_CONFLICT/,
	);
	assert.equal(submissions.length, 1);
});

test("drafts retain the selected sender through edits and approved sending", async (t) => {
	const { client, callTool, submissions } = await fixture(t);
	const args = {
		operationId: randomUUID(),
		from: alias,
		to: "recipient@example.com",
	};
	const created = DraftOperationOutputSchema.parse(
		await callTool("create_draft", args),
	);
	assert.ok("outcome" in created && "identity" in created.outcome);
	const draft = GetDraftOutputSchema.parse(
		await callTool("get_draft", created.outcome.identity),
	);
	assert.ok("revision" in draft);
	assert.equal(draft.from, alias);
	assert.match(
		JSON.stringify(
			await callTool("create_draft", { ...args, from: config.user }),
		),
		/OPERATION_CONFLICT/,
	);
	const edited = DraftOperationOutputSchema.parse(
		await callTool("edit_draft", {
			operationId: randomUUID(),
			draftId: draft.draftId,
			expectedRevision: draft.revision,
			text: "Edited body",
		}),
	);
	assert.ok("outcome" in edited && "identity" in edited.outcome);
	const updated = GetDraftOutputSchema.parse(
		await callTool("get_draft", edited.outcome.identity),
	);
	assert.ok("revision" in updated);
	assert.equal(updated.from, alias);
	const send = { operationId: randomUUID(), draftId: updated.draftId };
	const response = await client.callTool("send_draft", send);
	assert.ok(JSON.stringify(response).includes(`From: ${alias}`));
	const pending = continuationSchema.parse(response);
	const sent = await client.callTool("send_draft", send, {
		...approved,
		requestState: pending.requestState,
	});
	assert.ok(isSpecType.CallToolResult(sent));
	const result = SendOutputSchema.parse(sent.structuredContent);
	assert.ok("outcome" in result);
	assert.equal(result.outcome.status, "accepted");
	assert.equal(submissions[0]?.from, alias);
	assert.equal(submissions[0]?.text.trim(), "Edited body");
});

test("reply drafts allow an explicit sender and otherwise retain automatic alias selection", async (t) => {
	const { callTool } = await fixture(t);
	for (const from of [undefined, config.user]) {
		const created = DraftOperationOutputSchema.parse(
			await callTool("create_reply_draft", {
				...sourceIdentity,
				operationId: randomUUID(),
				...(from ? { from } : {}),
			}),
		);
		assert.ok("outcome" in created && "identity" in created.outcome);
		const draft = GetDraftOutputSchema.parse(
			await callTool("get_draft", created.outcome.identity),
		);
		assert.ok("revision" in draft);
		assert.equal(draft.from, from ?? alias);
		assert.deepEqual(draft.to, ["author@example.com"]);
	}
});

test("unconfigured or malformed sender selections fail before reading or writing mail", async (t) => {
	const { client, imapClient, submissions } = await fixture(t);
	for (const name of [
		"send_email",
		"forward_email",
		"create_draft",
		"create_reply_draft",
	]) {
		for (const from of [
			"stranger@example.com",
			"Name <work@example.com>",
			"work@example.com\r\nBcc: hidden@example.com",
		]) {
			const result = await client.callTool(name, {
				operationId: randomUUID(),
				from,
				to: "recipient@example.com",
				subject: "Topic",
				text: "Body",
				...(name === "forward_email" ? { source: sourceIdentity } : {}),
				...(name === "create_reply_draft" ? sourceIdentity : {}),
			});
			assert.ok(isSpecType.CallToolResult(result));
			assert.equal(result.isError, true);
		}
	}
	assert.equal(imapClient.sourceFetches, 0);
	assert.equal(imapClient.appends.length, 0);
	assert.equal(submissions.length, 0);
});
