import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { isSpecType } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createImapService } from "@/bridge/imap/service.js";
import {
	FakeImap,
	fixtureMessage,
	testConfig,
} from "@/bridge/testing/fixtures.js";
import { testFile, testImage } from "@/mail/outgoing/media/test-fixtures.js";
import type { OutgoingMessage } from "@/mail/outgoing/message.js";
import { createSendService } from "@/mail/sending/service.js";
import { createTestClient } from "@/mcp/integration/test-client.js";
import { createApprovalController } from "@/mcp/protocol/elicitation.js";
import { createServer } from "@/mcp/server.js";
import { createDraftStore } from "@/operations/sqlite/drafts.js";
import { createSendStore } from "@/operations/sqlite/sending.js";
import { createReadPolicy } from "@/policy/schema.js";
import { saveReadPolicy } from "@/policy/store.js";
import { ToolNameSchema } from "@/policy/tools.js";
import { SendOutputSchema } from "./schemas.js";

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
		changedForwardDuringLegacyApproval?: boolean;
		sourceChangedAfterVerifiedApproval?: boolean;
	} = {},
) {
	const directory = await mkdtemp(join(tmpdir(), "protonmail-send-mcp-"));
	const policyFile = join(directory, "policy.json");
	t.after(async () => {
		await rm(directory, { recursive: true, force: true });
	});
	await saveReadPolicy(
		createReadPolicy({
			bridgeUser: testConfig.user,
			allowedTools: ToolNameSchema.options,
			allowedMailboxes: ["INBOX", "Drafts", "Sent"],
			allowedSenderEmails: options.deniedSender
				? ["different@example.com"]
				: [],
		}),
		policyFile,
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
	const imap = createImapService(testConfig, {
		run: async (operation) => operation(client),
		draftStore: createDraftStore(testConfig.user, directory),
	});
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
	const controller = createApprovalController();
	const approval: ReturnType<typeof createApprovalController> = {
		...controller,
		async requireSendApproval(input, ctx) {
			const decision = await controller.requireSendApproval(input, ctx);
			if (
				decision.kind === "approved" &&
				options.sourceChangedAfterVerifiedApproval
			) {
				replaceInboxBody(client, "Changed after approval");
			}
			return decision;
		},
	};
	const factory = () =>
		createServer({
			config: testConfig,
			policyFile,
			operationsDirectory: directory,
			imap,
			sends,
			approval,
		});
	const legacy =
		options.changedDuringLegacyApproval !== undefined ||
		options.changedForwardDuringLegacyApproval !== undefined;
	const transport = await createTestClient(t, factory, {
		protocolVersion: legacy ? "2025-11-25" : "2026-07-28",
		capabilities: { elicitation: { form: {} } },
		onElicitation: async () => {
			if (options.changedDuringLegacyApproval)
				draft.source = Buffer.from(
					draft.source?.toString().replace("Original body", "Changed body") ??
						"",
				);
			if (options.changedForwardDuringLegacyApproval) {
				replaceInboxBody(client, "Changed source body");
			}
			return { action: "accept", content: { approve_send: true } };
		},
	});
	return { ...transport, client, draft, submissions, sends, policyFile };
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

function approvedContinuation(pending: { requestState: string }) {
	return {
		requestState: pending.requestState,
		inputResponses: acceptedResponse,
	};
}

function forwardArgs() {
	return {
		operationId: randomUUID(),
		source: { mailbox: "INBOX", uid: 2, uidValidity: "7" },
		to: "recipient@example.com",
	};
}

function replaceInboxBody(imap: FakeImap, replacement: string) {
	const source = imap.mailboxes.get("INBOX")?.[0];
	assert.ok(source?.source);
	source.source = Buffer.from(
		source.source.toString().replace("Body 2", replacement),
	);
}

test("modern draft send binds approval to the snapshot, preserves Bcc and threading, and retries without resending", async (t) => {
	const client = await fixture(t);
	const args = { ...identity, operationId: randomUUID() };
	const pending = parseContinuation(await client.callTool("send_draft", args));
	assert.equal(client.submissions.length, 0);
	const sent = sendResult(
		await client.callTool("send_draft", args, approvedContinuation(pending)),
	);
	assert.ok("outcome" in sent);
	assert.equal(sent.outcome.status, "accepted");
	assert.equal(sent.draftCleanup.status, "deleted");
	assert.equal(client.submissions.length, 1);
	const [submission] = client.submissions;
	assert.ok(submission);
	assert.deepEqual(submission.message.bcc, ["hidden@example.com"]);
	assert.deepEqual(submission.message.inReplyTo, ["<parent@example.com>"]);
	assert.equal(submission.message.text.trim(), "Original body");
	const replay = sendResult(
		await client.callTool("send_draft", args, approvedContinuation(pending)),
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
		await client.callTool("send_draft", args, approvedContinuation(pending)),
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
	const [submission] = client.submissions;
	assert.ok(submission);
	const message = submission.message;
	assert.deepEqual(message.to, [
		"Alice@example.com",
		"alias@example.com",
		"direct@example.com",
	]);
	assert.deepEqual(message.cc, ["bob@example.com"]);
	assert.deepEqual(message.bcc, ["hidden@example.com", "private@example.com"]);
});

test("send approval shows byte-free attachment/image manifests and binds exact payload bytes", async (t) => {
	const client = await fixture(t);
	const args = {
		operationId: randomUUID(),
		to: "recipient@example.com",
		subject: "Files",
		text: "Review files",
		attachments: [testFile],
		inlineImages: [testImage],
	};
	const result = await client.callTool("send_email", args);
	assert.match(JSON.stringify(result), /report\.pdf/);
	assert.match(JSON.stringify(result), /application\/pdf/);
	assert.match(JSON.stringify(result), /sha256/);
	assert.match(JSON.stringify(result), /inline/);
	assert.equal(JSON.stringify(result).includes(testFile.contentBase64), false);
	assert.equal(JSON.stringify(result).includes(testImage.contentBase64), false);
	const pending = parseContinuation(result);
	const modified = sendResult(
		await client.callTool(
			"send_email",
			{
				...args,
				attachments: [
					{
						...testFile,
						contentBase64: Buffer.from("Changed").toString("base64"),
					},
				],
			},
			approvedContinuation(pending),
		),
	);
	assert.ok("error" in modified);
	assert.equal(modified.error.code, "OPERATION_CONFLICT");
	assert.equal(client.submissions.length, 0);
	const sent = sendResult(
		await client.callTool("send_email", args, approvedContinuation(pending)),
	);
	assert.ok("outcome" in sent);
	assert.equal(sent.outcome.status, "accepted");
	assert.equal(sent.media?.length, 2);
	assert.equal(JSON.stringify(sent).includes("contentBase64"), false);
	assert.equal(
		client.submissions[0]?.message.media?.find(
			(part) => part.kind === "attachment",
		)?.file.contentBase64,
		testFile.contentBase64,
	);
});

test("forward approval quotes the authorized source, omits original Bcc/attachments, and retries without sending twice", async (t) => {
	const client = await fixture(t);
	const source = client.client.mailboxes.get("INBOX")?.[0];
	assert.ok(source);
	source.source = Buffer.from(
		"From: trusted@example.com\r\nTo: old@example.com\r\nBcc: original-hidden@example.com\r\nSubject: Source topic\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nOriginal source body\r\n--x\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=original.bin\r\n\r\nOriginal bytes\r\n--x--",
	);
	source.size = source.source.length;
	const args = { ...forwardArgs(), text: "FYI", attachments: [testFile] };
	const pending = parseContinuation(
		await client.callTool("forward_email", args),
	);
	assert.equal(client.submissions.length, 0);
	const sent = sendResult(
		await client.callTool("forward_email", args, approvedContinuation(pending)),
	);
	assert.ok("outcome" in sent);
	assert.equal(sent.outcome.status, "accepted");
	assert.equal(sent.source.kind, "forward");
	const outgoing = client.submissions[0]?.message;
	assert.ok(outgoing);
	assert.equal(outgoing.subject, "Fwd: Source topic");
	assert.match(outgoing.text, /FYI/);
	assert.match(outgoing.text, /Forwarded message/);
	assert.match(outgoing.text, /Original source body/);
	assert.equal(outgoing.text.includes("original-hidden"), false);
	assert.deepEqual(outgoing.bcc, []);
	assert.equal(outgoing.media?.length, 1);
	assert.equal(outgoing.media[0]?.file.filename, testFile.filename);
	assert.equal(client.client.downloads.length, 0);
	assert.equal(client.client.mailboxes.get("INBOX")?.length, 1);
	assert.equal(client.client.deletions, 0);
	assert.deepEqual(
		sendResult(await client.callTool("forward_email", args)),
		sent,
	);
	assert.equal(client.submissions.length, 1);
});

test("forward cancellation and source changes during modern or legacy approval never submit", async (t) => {
	await t.test("modern cancellation", async (t) => {
		const client = await fixture(t);
		const args = forwardArgs();
		const pending = parseContinuation(
			await client.callTool("forward_email", args),
		);
		const result = sendResult(
			await client.callTool("forward_email", args, {
				requestState: pending.requestState,
				inputResponses: { approve_send: { action: "decline" } },
			}),
		);
		assert.ok("error" in result);
		assert.equal(result.error.code, "APPROVAL_DENIED");
		assert.equal(client.submissions.length, 0);
	});
	await t.test("modern changed source", async (t) => {
		const client = await fixture(t);
		const args = forwardArgs();
		const pending = parseContinuation(
			await client.callTool("forward_email", args),
		);
		replaceInboxBody(client.client, "Changed source body");
		const result = sendResult(
			await client.callTool(
				"forward_email",
				args,
				approvedContinuation(pending),
			),
		);
		assert.ok("error" in result);
		assert.equal(result.error.code, "OPERATION_CONFLICT");
		assert.equal(client.submissions.length, 0);
	});
	await t.test("legacy changed source", async (t) => {
		const client = await fixture(t, {
			changedForwardDuringLegacyApproval: true,
		});
		const result = sendResult(
			await client.callTool("forward_email", forwardArgs()),
		);
		assert.ok("error" in result);
		assert.equal(result.error.code, "OPERATION_CONFLICT");
		assert.equal(client.submissions.length, 0);
	});
});

test("forward read policy is reauthorized after approval and original attachments are not auto-selected", async (t) => {
	const client = await fixture(t);
	const args = forwardArgs();
	const pending = parseContinuation(
		await client.callTool("forward_email", args),
	);
	await saveReadPolicy(
		createReadPolicy({
			bridgeUser: testConfig.user,
			allowedTools: ToolNameSchema.options,
			allowedMailboxes: ["Drafts"],
			allowedSenderEmails: [],
		}),
		client.policyFile,
	);
	const denied = sendResult(
		await client.callTool("forward_email", args, approvedContinuation(pending)),
	);
	assert.ok("error" in denied);
	assert.equal(denied.error.code, "POLICY_DENIED");
	assert.equal(client.submissions.length, 0);
	assert.equal(client.client.downloads.length, 0);
});

test("a changed quoted envelope fallback invalidates a forward approval", async (t) => {
	const client = await fixture(t);
	const original = client.client.mailboxes.get("INBOX")?.[0];
	assert.ok(original);
	original.source = Buffer.from("Subject: Without From\r\n\r\nBody 2");
	const args = forwardArgs();
	const pending = parseContinuation(
		await client.callTool("forward_email", args),
	);
	assert.ok(original.envelope);
	original.envelope.from = [{ address: "changed@example.com" }];
	const result = sendResult(
		await client.callTool("forward_email", args, approvedContinuation(pending)),
	);
	assert.ok("error" in result);
	assert.equal(result.error.code, "OPERATION_CONFLICT");
	assert.equal(client.submissions.length, 0);
});

test("forward source is refetched after the real approval decision succeeds", async (t) => {
	const client = await fixture(t, { sourceChangedAfterVerifiedApproval: true });
	const args = forwardArgs();
	const pending = parseContinuation(
		await client.callTool("forward_email", args),
	);
	const result = sendResult(
		await client.callTool("forward_email", args, approvedContinuation(pending)),
	);
	assert.ok("error" in result);
	assert.equal(result.error.code, "DRAFT_CHANGED");
	assert.equal(client.submissions.length, 0);
});
