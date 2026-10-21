import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import { z } from "zod";
import { createImapService } from "@/bridge/imap/service.js";
import {
	FakeImap,
	fixtureMessage,
	testConfig,
} from "@/bridge/testing/fixtures.js";
import {
	EditDraftRequestSchema,
	GetDraftSchema,
} from "@/mail/drafts/requests.js";
import { SendDraftRequestSchema } from "@/mail/sending/requests.js";
import { createSendService } from "@/mail/sending/service.js";
import { createTestClient } from "@/mcp/integration/test-client.js";
import { createServer } from "@/mcp/server.js";
import { SendOutputSchema } from "@/mcp/tools/sending/schemas.js";
import { createDraftStore } from "@/operations/sqlite/drafts.js";
import { createSendStore } from "@/operations/sqlite/sending.js";
import { createReadPolicy } from "@/policy/schema.js";
import { saveReadPolicy } from "@/policy/store.js";
import { ToolNameSchema } from "@/policy/tools.js";
import { DraftOperationOutputSchema, GetDraftOutputSchema } from "./schemas.js";

type ToolCall = Promise<Record<string, unknown>>;

async function draftOperation(call: ToolCall) {
	return DraftOperationOutputSchema.parse((await call).structuredContent);
}

async function editableDraft(call: ToolCall) {
	return GetDraftOutputSchema.parse((await call).structuredContent);
}

async function fixture(t: TestContext, fake = new FakeImap()) {
	const directory = await mkdtemp(join(tmpdir(), "protonmail-draft-ids-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const policyFile = join(directory, "policy.json");
	const policy = createReadPolicy({
		bridgeUser: testConfig.user,
		allowedTools: ToolNameSchema.options,
		allowedMailboxes: ["Drafts"],
	});
	await saveReadPolicy(policy, policyFile);
	fake.mailboxes.set("Drafts", []);
	const store = createDraftStore(testConfig.user, directory);
	const submissions: string[] = [];
	async function client() {
		return createTestClient(
			t,
			() =>
				createServer({
					config: testConfig,
					policyFile,
					operationsDirectory: directory,
					imap: createImapService(testConfig, {
						run: async (operation) => operation(fake),
						draftStore: createDraftStore(testConfig.user, directory),
					}),
					sends: createSendService(testConfig, {
						store: createSendStore(testConfig.user, directory),
						submit: async (message) => {
							submissions.push(message.text);
							return { status: "accepted", accepted: message.to, rejected: [] };
						},
					}),
				}),
			{
				capabilities: { elicitation: { form: {} } },
				onElicitation: async () => ({
					action: "accept",
					content: { approve_send: true },
				}),
			},
		);
	}
	const api = await client();
	async function read(draftId: string) {
		const result = await editableDraft(api.callTool("get_draft", { draftId }));
		assert.ok("draftId" in result);
		return result;
	}
	async function create() {
		const result = await draftOperation(
			api.callTool("create_draft", {
				operationId: randomUUID(),
				to: "recipient@example.com",
				text: "First",
			}),
		);
		assert.ok("draftId" in result);
		assert.equal(result.outcome.status, "completed");
		return result;
	}
	return {
		api,
		client,
		read,
		create,
		store,
		fake,
		directory,
		policy,
		policyFile,
		submissions,
	};
}

test("one draft ID survives repeated logical and physical edits, replays, and process restart", async (t) => {
	const f = await fixture(t);
	const created = await f.create();
	const originalRecord = await f.store.get(created.operationId);
	const first = await f.read(created.draftId);
	const request = {
		operationId: randomUUID(),
		draftId: created.draftId,
		expectedRevision: first.revision,
		text: "Second",
	};
	const edited = await draftOperation(f.api.callTool("edit_draft", request));
	assert.ok("draftId" in edited && "identity" in edited.outcome);
	assert.equal(edited.draftId, created.draftId);
	const second = await f.read(created.draftId);
	assert.notEqual(second.uid, first.uid);
	assert.equal(second.text.trim(), "Second");
	const physical = {
		operationId: randomUUID(),
		uid: second.uid,
		uidValidity: second.uidValidity,
		expectedRevision: second.revision,
		text: "Third",
	};
	const next = await draftOperation(f.api.callTool("edit_draft", physical));
	assert.ok("draftId" in next);
	assert.equal(next.draftId, created.draftId);
	assert.deepEqual(
		(await f.api.callTool("edit_draft", request)).structuredContent,
		edited,
	);
	assert.equal(f.fake.appends.length, 3);
	const restarted = await f.client();
	const current = await editableDraft(
		restarted.callTool("get_draft", { draftId: created.draftId }),
	);
	assert.ok("draftId" in current);
	assert.equal(current.text.trim(), "Third");
	assert.equal(
		(
			await f.api.callTool("edit_draft", {
				...request,
				operationId: randomUUID(),
			})
		).isError,
		true,
	);
	assert.equal(f.fake.appends.length, 3);
	assert.deepEqual(await f.store.get(created.operationId), originalRecord);
});

test("existing IMAP drafts are adopted once and keep their logical ID after replacement", async (t) => {
	const f = await fixture(t);
	f.fake.mailboxes.set("Drafts", [
		fixtureMessage(1, { sender: testConfig.user }),
	]);
	const identity = { mailbox: "Drafts", uid: 1, uidValidity: "7" };
	const original = await editableDraft(f.api.callTool("get_draft", identity));
	assert.ok("draftId" in original);
	const result = await draftOperation(
		f.api.callTool("edit_draft", {
			operationId: randomUUID(),
			uid: 1,
			uidValidity: "7",
			expectedRevision: original.revision,
			text: "Adopted",
		}),
	);
	assert.ok("draftId" in result);
	assert.equal(result.draftId, original.draftId);
	assert.equal((await f.read(original.draftId)).text.trim(), "Adopted");
});

test("uncertain replacement keeps its ID, blocks resolution, and recovers without another APPEND", async (t) => {
	const f = await fixture(t);
	const created = await f.create();
	const original = await f.read(created.draftId);
	const append = f.fake.append.bind(f.fake);
	f.fake.append = async (...args) => {
		await append(...args);
		throw new Error("Lost APPEND acknowledgement");
	};
	const request = {
		operationId: randomUUID(),
		draftId: created.draftId,
		expectedRevision: original.revision,
		text: "Recovered",
	};
	const uncertain = await draftOperation(f.api.callTool("edit_draft", request));
	assert.ok("draftId" in uncertain);
	assert.equal(uncertain.draftId, created.draftId);
	assert.equal(uncertain.outcome.status, "appending");
	assert.equal(
		(await f.api.callTool("get_draft", { draftId: created.draftId })).isError,
		true,
	);
	assert.deepEqual(
		(await f.api.callTool("edit_draft", request)).structuredContent,
		uncertain,
	);
	// Inspecting a discovered replacement before reconciliation must not invent a second ID.
	const discovered = await editableDraft(
		f.api.callTool("get_draft", {
			mailbox: "Drafts",
			uid: 100,
			uidValidity: "7",
		}),
	);
	assert.ok("draftId" in discovered);
	assert.equal(discovered.draftId, created.draftId);
	const recovered = await draftOperation(
		f.api.callTool("reconcile_draft_operation", {
			operationId: request.operationId,
		}),
	);
	assert.ok("draftId" in recovered);
	assert.equal(recovered.draftId, created.draftId);
	await f.api.callTool("retry_draft_cleanup", {
		operationId: request.operationId,
	});
	assert.equal((await f.read(created.draftId)).text.trim(), "Recovered");
	assert.equal(f.fake.appends.length, 2);
});

test("logical draft IDs preserve account, sender, mailbox, UIDVALIDITY and send protections", async (t) => {
	const f = await fixture(t);
	const created = await f.create();
	f.fake.uidValidity = 8n;
	assert.equal(
		(await f.api.callTool("get_draft", { draftId: created.draftId })).isError,
		true,
	);
	f.fake.uidValidity = 7n;
	for (const policy of [
		{ ...f.policy, allowedMailboxes: ["INBOX"] },
		{ ...f.policy, allowedSenderEmails: ["denied@example.com"] },
	]) {
		await saveReadPolicy(policy, f.policyFile);
		assert.equal(
			(await f.api.callTool("get_draft", { draftId: created.draftId })).isError,
			true,
		);
	}
	await saveReadPolicy(f.policy, f.policyFile);
	await assert.rejects(
		createDraftStore("other@example.com", f.directory).resolve(created.draftId),
		/not found/,
	);
	const request = { operationId: randomUUID(), draftId: created.draftId };
	const sent = SendOutputSchema.parse(
		(await f.api.callTool("send_draft", request)).structuredContent,
	);
	assert.ok("outcome" in sent);
	assert.equal(sent.outcome.status, "accepted");
	assert.deepEqual(
		(await f.api.callTool("send_draft", request)).structuredContent,
		sent,
	);
	assert.equal(f.submissions.length, 1);
	assert.equal(
		(await f.api.callTool("get_draft", { draftId: created.draftId })).isError,
		true,
	);
});

test("legacy journal migration preserves edit lineage and immutable replay hashes", async (t) => {
	const f = await fixture(t);
	const created = await f.create();
	const original = await f.read(created.draftId);
	const request = {
		operationId: randomUUID(),
		uid: original.uid,
		uidValidity: original.uidValidity,
		expectedRevision: original.revision,
		text: "Migrated",
	};
	await f.api.callTool("edit_draft", request);
	const before = await f.store.get(request.operationId);
	assert.ok(before);
	const db = new DatabaseSync(f.store.path);
	try {
		db.exec(
			"UPDATE drafts SET record = json_remove(record, '$.draftId'); DROP TABLE draft_identities; DROP TABLE draft_identity_migrations; DROP INDEX drafts_by_logical_id;",
		);
	} finally {
		db.close();
	}
	const migrated = await createDraftStore(testConfig.user, f.directory).get(
		request.operationId,
	);
	assert.ok(migrated);
	assert.equal(migrated.draftId, created.draftId);
	assert.equal(migrated.requestHash, before.requestHash);
	assert.deepEqual(migrated.outcome, before.outcome);
	assert.equal((await f.read(created.draftId)).text.trim(), "Migrated");
	assert.equal(f.fake.appends.length, 2);
});

test("rejected edits preserve the original logical binding and pending cleanup blocks another edit", async (t) => {
	const f = await fixture(t);
	const created = await f.create();
	const original = await f.read(created.draftId);
	const claim = f.store.claim;
	const imap = createImapService(testConfig, {
		run: async (operation) => operation(f.fake),
		draftStore: {
			...f.store,
			claim: async (...args) => {
				const result = await claim(...args);
				await saveReadPolicy(
					{
						...f.policy,
						allowedTools: f.policy.allowedTools.filter(
							(name) => name !== "edit_draft",
						),
					},
					f.policyFile,
				);
				return result;
			},
		},
	});
	const { createMailAccess } = await import("@/mail/access.js");
	const mail = await createMailAccess(imap, testConfig.user, f.policyFile);
	const rejected = await mail.editDraft({
		operationId: randomUUID(),
		draftId: created.draftId,
		expectedRevision: original.revision,
		text: "Never written",
	});
	assert.equal(rejected.outcome.status, "rejected");
	assert.equal(rejected.draftId, created.draftId);
	assert.equal((await f.read(created.draftId)).uid, original.uid);
	await saveReadPolicy(f.policy, f.policyFile);
	f.fake.deleteFailure = "throw";
	const replacement = await draftOperation(
		f.api.callTool("edit_draft", {
			operationId: randomUUID(),
			draftId: created.draftId,
			expectedRevision: original.revision,
			text: "Cleanup pending",
		}),
	);
	assert.ok("draftId" in replacement);
	assert.equal(replacement.outcome.status, "cleanup_failed");
	const current = await f.read(created.draftId);
	assert.equal(current.text.trim(), "Cleanup pending");
	assert.equal(
		(
			await f.api.callTool("edit_draft", {
				operationId: randomUUID(),
				draftId: created.draftId,
				expectedRevision: current.revision,
				text: "Blocked",
			})
		).isError,
		true,
	);
	assert.equal(f.fake.appends.length, 2);
});

test("concurrent logical edits keep one identity lineage and only one replacement", async (t) => {
	const f = await fixture(t);
	const created = await f.create();
	const original = await f.read(created.draftId);
	const other = await f.client();
	const results = await Promise.all(
		[f.api, other].map((api) =>
			api.callTool("edit_draft", {
				operationId: randomUUID(),
				draftId: created.draftId,
				expectedRevision: original.revision,
				text: "Concurrent",
			}),
		),
	);
	assert.equal(results.filter((result) => result.isError !== true).length, 1);
	assert.equal(f.fake.appends.length, 2);
	assert.equal((await f.read(created.draftId)).draftId, created.draftId);
});

test("draft selectors reject mixed logical and physical identities", () => {
	const draftId = randomUUID();
	const physical = { uid: 1, uidValidity: "7" };
	assert.equal(
		GetDraftSchema.safeParse({ draftId, mailbox: "Drafts", ...physical })
			.success,
		false,
	);
	assert.equal(
		EditDraftRequestSchema.safeParse({
			draftId,
			...physical,
			operationId: randomUUID(),
			expectedRevision: "0".repeat(64),
		}).success,
		false,
	);
	assert.equal(
		SendDraftRequestSchema.safeParse({
			draftId,
			...physical,
			operationId: randomUUID(),
		}).success,
		false,
	);
});

test("restored historical copies receive separate IDs and cannot redirect the current draft", async (t) => {
	const f = await fixture(t);
	const created = await f.create();
	const original = await f.read(created.draftId);
	const saved = f.fake.mailboxes
		.get("Drafts")
		?.find((message) => message.uid === original.uid);
	assert.ok(saved);
	await f.api.callTool("edit_draft", {
		operationId: randomUUID(),
		draftId: created.draftId,
		expectedRevision: original.revision,
		text: "Current version",
	});
	const restored = { ...saved, uid: 500, seq: 500 };
	f.fake.mailboxes.set("Drafts", [
		...(f.fake.mailboxes.get("Drafts") ?? []),
		restored,
	]);
	const copy = await editableDraft(
		f.api.callTool("get_draft", {
			mailbox: "Drafts",
			uid: 500,
			uidValidity: "7",
		}),
	);
	assert.ok("draftId" in copy);
	assert.notEqual(copy.draftId, created.draftId);
	const edited = await draftOperation(
		f.api.callTool("edit_draft", {
			operationId: randomUUID(),
			draftId: copy.draftId,
			expectedRevision: copy.revision,
			text: "Independent copy",
		}),
	);
	assert.ok("draftId" in edited);
	assert.equal(edited.draftId, copy.draftId);
	assert.equal((await f.read(created.draftId)).text.trim(), "Current version");
	assert.equal((await f.read(copy.draftId)).text.trim(), "Independent copy");
});

test("a creation operation cannot reuse an adopted logical ID", async (t) => {
	const f = await fixture(t);
	f.fake.mailboxes.set("Drafts", [
		fixtureMessage(1, { sender: testConfig.user }),
	]);
	const adopted = await editableDraft(
		f.api.callTool("get_draft", {
			mailbox: "Drafts",
			uid: 1,
			uidValidity: "7",
		}),
	);
	assert.ok("draftId" in adopted);
	const collision = await f.api.callTool("create_draft", {
		operationId: adopted.draftId,
		text: "Unrelated composition",
	});
	assert.equal(collision.isError, true);
	assert.match(
		JSON.stringify(collision.structuredContent),
		/OPERATION_CONFLICT/,
	);
	assert.equal(f.fake.appends.length, 0);
	assert.equal((await f.read(adopted.draftId)).uid, 1);
});

test("journal reads use indexed logical lookup and do not require a writer transaction after migration", async (t) => {
	const f = await fixture(t);
	const created = await f.create();
	const db = new DatabaseSync(f.store.path);
	try {
		const plan = z
			.array(z.object({ detail: z.string() }))
			.parse(
				db
					.prepare(
						"EXPLAIN QUERY PLAN SELECT record FROM drafts WHERE json_extract(record, '$.draftId') = ? AND json_extract(record, '$.outcome.status') != 'rejected' ORDER BY rowid DESC LIMIT 1",
					)
					.all(created.draftId),
			);
		assert.ok(plan.some((row) => row.detail.includes("drafts_by_logical_id")));
		db.exec("BEGIN IMMEDIATE");
		assert.equal(
			(await f.store.get(created.operationId))?.draftId,
			created.draftId,
		);
		assert.equal((await f.store.resolve(created.draftId)).mailbox, "Drafts");
		assert.deepEqual(await f.store.list(10, 0), []);
		db.exec("ROLLBACK");
	} finally {
		db.close();
	}
});
