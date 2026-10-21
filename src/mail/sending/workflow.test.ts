import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { createImapService } from "../../bridge/imap/service.js";
import {
	FakeImap,
	fixtureMessage,
	testConfig,
} from "../../bridge/testing/fixtures.js";
import { createDraftStore } from "../../operations/sqlite/drafts.js";
import { createSendStore } from "../../operations/sqlite/sending.js";
import { createToolAccess } from "../../policy/access.js";
import { createReadPolicy } from "../../policy/schema.js";
import { saveReadPolicy } from "../../policy/store.js";
import { ToolNameSchema } from "../../policy/tools.js";
import { MailError } from "../../shared/mail-error.js";
import { createMailAccess } from "../access.js";
import { SendEmailSchema } from "./requests.js";
import { createSendService } from "./service.js";
import { createSendWorkflow } from "./workflow.js";

async function fixture(t: TestContext, revokeAfterClaim = false) {
	const directory = await mkdtemp(join(tmpdir(), "protonmail-send-workflow-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const policyFile = join(directory, "policy.json");
	const policy = createReadPolicy({
		bridgeUser: testConfig.user,
		allowedTools: ToolNameSchema.options,
		allowedMailboxes: ["INBOX", "Drafts", "Sent"],
	});
	await saveReadPolicy(policy, policyFile);
	const client = new FakeImap();
	const original = fixtureMessage(1);
	client.mailboxes.set("INBOX", [original]);
	const draft = fixtureMessage(1, { sender: testConfig.user });
	draft.source = Buffer.from(
		`From: ${testConfig.user}\r\nTo: recipient@example.com\r\nSubject: Draft\r\nMessage-ID: <draft@example.com>\r\n\r\nDraft body`,
	);
	draft.size = draft.source.length;
	client.mailboxes.set("Drafts", [draft]);
	const imap = createImapService(testConfig, {
		run: async (operation) => operation(client),
		draftStore: createDraftStore(testConfig.user, directory),
	});
	const store = createSendStore(testConfig.user, directory);
	let submissions = 0;
	const sends = createSendService(testConfig, {
		store: {
			...store,
			async claim(...args) {
				const claimed = await store.claim(...args);
				if (revokeAfterClaim)
					await saveReadPolicy({ ...policy, allowedTools: [] }, policyFile);
				return claimed;
			},
		},
		submit: async (message) => {
			submissions++;
			return {
				status: "accepted",
				accepted: [...message.to, ...message.cc, ...message.bcc],
				rejected: [],
			};
		},
	});
	return {
		client,
		original,
		draft,
		sends,
		submissions: () => submissions,
		workflow: createSendWorkflow({
			config: testConfig,
			sends,
			access: createToolAccess(testConfig.user, policyFile),
			mailAccess: () => createMailAccess(imap, testConfig.user, policyFile),
		}),
	};
}

test("the send workflow preserves an opaque approval response without claiming submission", async (t) => {
	const f = await fixture(t);
	const request = SendEmailSchema.parse({
		operationId: randomUUID(),
		to: "recipient@example.com",
		subject: "Reviewed",
		text: "Body",
	});
	const response = { continuation: Symbol("protocol-owned response") };
	const result = await f.workflow.email(request, async (approval) => {
		assert.equal(approval.operationId, request.operationId);
		assert.equal(approval.message.text, request.text);
		assert.equal(
			(await f.sends.get(request.operationId)).outcome.status,
			"prepared",
		);
		return { kind: "response", response };
	});
	assert.equal(result.kind, "response");
	if (result.kind !== "response") throw new Error("Expected approval response");
	assert.equal(result.response, response);
	assert.equal(
		(await f.sends.get(request.operationId)).outcome.status,
		"prepared",
	);
	assert.equal(f.submissions(), 0);
});

test("the send workflow refuses a forward changed during approval before claiming submission", async (t) => {
	const f = await fixture(t);
	const operationId = randomUUID();
	await assert.rejects(
		f.workflow.forward(
			{
				operationId,
				source: { mailbox: "INBOX", uid: 1, uidValidity: "7" },
				to: ["recipient@example.com"],
				text: "FYI",
			},
			async () => {
				assert.ok(f.original.source);
				f.original.source = Buffer.from(
					f.original.source.toString().replace("Body 1", "Changed"),
				);
				return { kind: "approved" };
			},
		),
		(error: unknown) =>
			error instanceof MailError && error.code === "DRAFT_CHANGED",
	);
	assert.equal((await f.sends.get(operationId)).outcome.status, "prepared");
	assert.equal(f.submissions(), 0);
});

test("the send workflow reauthorizes after its durable claim and never retries a denied submission", async (t) => {
	const f = await fixture(t, true);
	const request = SendEmailSchema.parse({
		operationId: randomUUID(),
		to: "recipient@example.com",
		subject: "Reviewed",
		text: "Body",
	});
	const result = await f.workflow.email(request, async () => ({
		kind: "approved",
	}));
	assert.equal(result.kind, "operation");
	if (result.kind !== "operation") throw new Error("Expected send operation");
	assert.equal(result.operation.outcome.status, "rejected");
	assert.equal(f.submissions(), 0);
	const replay = await f.workflow.email(request, async () => {
		throw new Error(
			"A durable rejected operation must not ask for approval again",
		);
	});
	assert.deepEqual(replay, result);
	assert.equal(f.submissions(), 0);
});

test("the draft workflow records acceptance before deletion and reports cleanup failure separately", async (t) => {
	const f = await fixture(t);
	const operationId = randomUUID();
	const messageDelete = f.client.messageDelete.bind(f.client);
	f.client.messageDelete = async (...args) => {
		assert.equal((await f.sends.get(operationId)).outcome.status, "accepted");
		return messageDelete(...args);
	};
	f.client.deleteFailure = "throw";
	const result = await f.workflow.draft(
		{ operationId, uid: 1, uidValidity: "7" },
		async () => ({ kind: "approved" }),
	);
	assert.equal(result.kind, "operation");
	if (result.kind !== "operation") throw new Error("Expected send operation");
	assert.equal(result.operation.outcome.status, "accepted");
	assert.equal(result.operation.draftCleanup.status, "failed");
	assert.equal(f.submissions(), 1);
	assert.equal(f.client.mailboxes.get("Drafts")?.length, 1);
	f.client.deleteFailure = "none";
	const cleaned = await f.workflow.retryCleanup(operationId);
	assert.equal(cleaned.outcome.status, "accepted");
	assert.equal(cleaned.draftCleanup.status, "deleted");
	assert.equal(f.submissions(), 1);
});

test("accepted source-backed sends replay after their source disappears without requesting approval", async (t) => {
	for (const kind of ["forward", "draft"] as const) {
		await t.test(kind, async (t) => {
			const f = await fixture(t);
			const operationId = randomUUID();
			const invoke = (approve: Parameters<typeof f.workflow.draft>[1]) =>
				kind === "draft"
					? f.workflow.draft({ operationId, uid: 1, uidValidity: "7" }, approve)
					: f.workflow.forward(
							{
								operationId,
								source: { mailbox: "INBOX", uid: 1, uidValidity: "7" },
								to: ["recipient@example.com"],
								text: "FYI",
							},
							approve,
						);
			const result = await invoke(async () => ({ kind: "approved" }));
			assert.equal(result.kind, "operation");
			assert.ok(result.kind === "operation");
			assert.equal(result.operation.outcome.status, "accepted");
			f.client.mailboxes.set(kind === "draft" ? "Drafts" : "INBOX", []);
			assert.deepEqual(
				await invoke(async () => {
					throw new Error("An accepted send must not request approval again");
				}),
				result,
			);
			assert.equal(f.submissions(), 1);
		});
	}
});
