import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { isSpecType } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createImapService } from "../bridge/imap.js";
import {
	FakeImap,
	fixtureMessage,
	testConfig,
} from "../bridge/test-fixtures.js";
import { createReadPolicy } from "../policy/schema.js";
import { saveReadPolicy } from "../policy/store.js";
import type { OutgoingMessage } from "../sending/model.js";
import { createSendService } from "../sending/service.js";
import { createSendStore } from "../sending/store.js";
import { createSendApprovalController } from "./elicitation.js";
import { SendOutputSchema } from "./output-schemas.js";
import { createServer } from "./server.js";
import { createTestClient } from "./test-client.js";

const identity = { uid: 1, uidValidity: "7" };
const acceptedResponse = {
	approve_send: { action: "accept", content: { approve_send: true } },
};
const continuationSchema = z.object({
	resultType: z.literal("input_required"),
	requestState: z.string(),
});

async function fixture(
	t: TestContext,
	options: {
		changedDuringLegacyApproval?: boolean;
		deleteFailure?: boolean;
		deniedSender?: boolean;
		groupedRecipients?: boolean;
	} = {},
) {
	const directory = await mkdtemp(join(tmpdir(), "protonmail-send-mcp-"));
	const oldPath = process.env.PROTONMAIL_MCP_POLICY_FILE;
	process.env.PROTONMAIL_MCP_POLICY_FILE = join(directory, "policy.json");
	t.after(async () => {
		if (oldPath === undefined) delete process.env.PROTONMAIL_MCP_POLICY_FILE;
		else process.env.PROTONMAIL_MCP_POLICY_FILE = oldPath;
		await rm(directory, { recursive: true, force: true });
	});
	await saveReadPolicy(
		createReadPolicy({
			bridgeUser: testConfig.user,
			allowedMailboxes: ["INBOX", "Drafts", "Sent"],
			allowedSenderEmails: options.deniedSender
				? ["different@example.com"]
				: [],
		}),
	);
	const client = new FakeImap();
	const draft = fixtureMessage(1, { sender: testConfig.user });
	draft.source = Buffer.from(
		`From: ${testConfig.user}\r\nTo: recipient@example.com\r\nBcc: hidden@example.com\r\nSubject: Reviewed\r\nMessage-ID: <draft@example.com>\r\nIn-Reply-To: <parent@example.com>\r\nReferences: <root@example.com> <parent@example.com>\r\n\r\nOriginal body`,
	);
	if (options.groupedRecipients)
		draft.source = Buffer.from(
			`From: ${testConfig.user}\r\nTo: Team: Alice@example.com, alias@example.com; , direct@example.com\r\nCc: Reviewers: bob@example.com;\r\nBcc: Hidden: hidden@example.com, private@example.com;\r\nSubject: Groups\r\n\r\nOriginal body`,
		);
	client.mailboxes.set("Drafts", [draft]);
	client.mailboxes.set("Sent", []);
	client.mailboxes.set("INBOX", [fixtureMessage(2)]);
	if (options.deleteFailure) client.deleteFailure = "throw";
	const imap = createImapService(testConfig, async (operation) =>
		operation(client),
	);
	const submissions: { message: OutgoingMessage; messageId: string }[] = [];
	const sends = createSendService(testConfig, {
		store: createSendStore(testConfig.user, directory),
		submit: async (message, messageId) => {
			submissions.push({ message, messageId });
			return {
				status: "accepted",
				accepted: [...message.to, ...message.cc, ...message.bcc],
				rejected: [],
			};
		},
	});
	const approval = createSendApprovalController();
	const factory = () =>
		createServer({ config: testConfig, imap, sends, approval });
	const legacy = options.changedDuringLegacyApproval !== undefined;
	const transport = await createTestClient(t, factory, {
		protocolVersion: legacy ? "2025-11-25" : "2026-07-28",
		capabilities: { elicitation: { form: {} } },
		onElicitation: async () => {
			if (options.changedDuringLegacyApproval)
				draft.source = Buffer.from(
					draft.source?.toString().replace("Original body", "Changed body") ??
						"",
				);
			return { action: "accept", content: { approve_send: true } };
		},
	});
	return { ...transport, client, draft, submissions, sends };
}

function parseContinuation(value: unknown) {
	const parsed = continuationSchema.safeParse(value);
	assert.ok(parsed.success, JSON.stringify(value));
	return parsed.data;
}

function sendResult(value: unknown) {
	assert.ok(isSpecType.CallToolResult(value));
	return SendOutputSchema.parse(value.structuredContent);
}

test("modern draft send binds approval to the snapshot, preserves Bcc and threading, and retries without resending", async (t) => {
	const client = await fixture(t);
	const args = { ...identity, operationId: randomUUID() };
	const pending = parseContinuation(await client.callTool("send_draft", args));
	assert.equal(client.submissions.length, 0);
	const sent = sendResult(
		await client.callTool("send_draft", args, {
			requestState: pending.requestState,
			inputResponses: acceptedResponse,
		}),
	);
	assert.ok("outcome" in sent);
	assert.equal(sent.outcome.status, "accepted");
	assert.equal(sent.draftCleanup.status, "deleted");
	assert.equal(client.submissions.length, 1);
	assert.deepEqual(client.submissions[0].message.bcc, ["hidden@example.com"]);
	assert.deepEqual(client.submissions[0].message.inReplyTo, [
		"<parent@example.com>",
	]);
	assert.equal(client.submissions[0].message.text.trim(), "Original body");
	const replay = sendResult(
		await client.callTool("send_draft", args, {
			requestState: pending.requestState,
			inputResponses: acceptedResponse,
		}),
	);
	assert.ok("outcome" in replay);
	assert.equal(replay.outcome.status, "accepted");
	assert.equal(client.submissions.length, 1);
});

test("draft changed between modern approval rounds is refused before SMTP", async (t) => {
	const client = await fixture(t);
	const args = { ...identity, operationId: randomUUID() };
	const pending = parseContinuation(await client.callTool("send_draft", args));
	client.draft.source = Buffer.from(
		"From: bridge@example.com\r\nTo: attacker@example.com\r\n\r\nChanged",
	);
	const refused = sendResult(
		await client.callTool("send_draft", args, {
			requestState: pending.requestState,
			inputResponses: acceptedResponse,
		}),
	);
	assert.ok("error" in refused);
	assert.equal(refused.error.code, "OPERATION_CONFLICT");
	assert.equal(client.submissions.length, 0);
});

test("legacy approval sends its snapshot and refuses edits made while the dialog is open", async (t) => {
	for (const changed of [false, true])
		await t.test(String(changed), async (t) => {
			const client = await fixture(t, {
				changedDuringLegacyApproval: changed,
				deleteFailure: true,
			});
			const result = sendResult(
				await client.callTool("send_draft", {
					...identity,
					operationId: randomUUID(),
				}),
			);
			if (changed) {
				assert.ok("error" in result);
				assert.equal(client.submissions.length, 0);
			} else {
				assert.ok("outcome" in result, JSON.stringify(result));
				assert.equal(result.outcome.status, "accepted");
				assert.equal(result.draftCleanup.status, "failed");
				assert.equal(client.submissions.length, 1);
			}
		});
});

test("draft sender policy is enforced before source reads and approval", async (t) => {
	const client = await fixture(t, { deniedSender: true });
	const refused = sendResult(
		await client.callTool("send_draft", {
			...identity,
			operationId: randomUUID(),
		}),
	);
	assert.ok("error" in refused);
	assert.equal(refused.error.code, "POLICY_DENIED");
	assert.equal(client.client.sourceFetches, 0);
	assert.equal(client.submissions.length, 0);
});

test("sending a draft retains all grouped To, Cc, and Bcc recipients", async (t) => {
	const client = await fixture(t, {
		groupedRecipients: true,
		changedDuringLegacyApproval: false,
	});
	const result = sendResult(
		await client.callTool("send_draft", {
			...identity,
			operationId: randomUUID(),
		}),
	);
	assert.ok("outcome" in result);
	assert.equal(result.outcome.status, "accepted");
	assert.equal(client.submissions.length, 1);
	const message = client.submissions[0].message;
	assert.deepEqual(message.to, [
		"Alice@example.com",
		"alias@example.com",
		"direct@example.com",
	]);
	assert.deepEqual(message.cc, ["bob@example.com"]);
	assert.deepEqual(message.bcc, ["hidden@example.com", "private@example.com"]);
});
