import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import type { DraftOperation } from "@/mail/drafts/model.js";
import type { SendOperation } from "@/mail/sending/model.js";
import { createOperationJournal } from "./journal.js";

const account = "journal@example.com";
const original = { mailbox: "Drafts", uidValidity: "7", uid: 1 };
const replacement = { ...original, uid: 2 };

async function fixture(t: TestContext) {
	const directory = await mkdtemp(
		join(tmpdir(), "protonmail-account-journal-"),
	);
	t.after(() => rm(directory, { recursive: true, force: true }));
	const journal = createOperationJournal(account, directory);
	return { directory, journal };
}

function draftRecord(): Omit<DraftOperation, "draftId"> {
	const operationId = randomUUID();
	const now = new Date().toISOString();
	return {
		operationId,
		messageId: `<${operationId}@example.com>`,
		requestHash: `request-${operationId}`,
		contentHash: `content-${operationId}`,
		media: [],
		mailbox: "Drafts",
		source: { kind: "create" },
		outcome: { status: "appending" },
		createdAt: now,
		updatedAt: now,
	};
}

function sendRecord(): SendOperation {
	const operationId = randomUUID();
	const now = new Date().toISOString();
	return {
		operationId,
		messageId: `<${operationId}@protonmail-mcp.local>`,
		requestHash: "approved request",
		contentHash: "approved content",
		media: [],
		source: { kind: "email" },
		outcome: { status: "prepared" },
		draftCleanup: { status: "not_applicable" },
		sentCopies: [],
		createdAt: now,
		updatedAt: now,
	};
}

test("reopening the account journal preserves draft lineage, replay hashes, and claims", async (t) => {
	const { directory, journal } = await fixture(t);
	const created = draftRecord();
	await journal.drafts.claim(created);
	await journal.drafts.saved(
		created.operationId,
		original,
		"original revision",
	);
	const edit = {
		...draftRecord(),
		source: { kind: "edit", ...original, revision: "original revision" },
	} satisfies Omit<DraftOperation, "draftId">;
	await journal.drafts.claim(edit, created.messageId);
	await journal.drafts.saved(
		edit.operationId,
		replacement,
		"replacement revision",
	);
	const before = await journal.drafts.cleanup(edit.operationId, {
		status: "completed",
	});

	const reopened = createOperationJournal(account, directory);
	const otherInstance = createOperationJournal(account, directory);
	const [resolved, stored, missing] = await Promise.all([
		reopened.drafts.resolve(created.operationId),
		otherInstance.drafts.get(edit.operationId),
		reopened.inbox.get(randomUUID()),
	]);
	assert.deepEqual(resolved, replacement);
	assert.deepEqual(stored, before);
	assert.equal(missing, null);
	await assert.rejects(
		reopened.drafts.claim({
			...draftRecord(),
			source: { kind: "edit", ...original, revision: "original revision" },
		}),
		{ code: "OPERATION_CONFLICT" },
	);
});

test("unsupported journals are refused by every facet without rewriting records", async (t) => {
	for (const version of [0, 2]) {
		await t.test(String(version), async (t) => {
			const { directory, journal } = await fixture(t);
			const draft = draftRecord();
			await journal.drafts.claim(draft);
			const db = new DatabaseSync(journal.drafts.path);
			try {
				db.exec(`PRAGMA user_version=${version}`);
				const before = db.prepare("SELECT * FROM drafts").all();
				const reopened = createOperationJournal(account, directory);
				for (const access of [
					() => reopened.sends.prepare(sendRecord()),
					() => reopened.inbox.get(randomUUID()),
					() => reopened.drafts.get(draft.operationId),
					() => reopened.checkIntegrity(),
				]) {
					await assert.rejects(access(), {
						code: "STORAGE_FAILED",
						message: /Unsupported operation journal/,
					});
				}
				assert.deepEqual(db.prepare("SELECT * FROM drafts").all(), before);
				assert.deepEqual(db.prepare("SELECT * FROM sends").all(), []);
				assert.deepEqual(db.prepare("PRAGMA user_version").get(), {
					__proto__: null,
					user_version: version,
				});
			} finally {
				db.close();
			}
		});
	}
});

test("concurrent startup initializes all journal facets and isolates accounts", async (t) => {
	const { directory, journal } = await fixture(t);
	const second = createOperationJournal(account, directory);
	const draft = draftRecord();
	const send = sendRecord();
	const [claimed, prepared, missing] = await Promise.all([
		journal.drafts.claim(draft),
		second.sends.prepare(send),
		journal.inbox.get(randomUUID()),
	]);
	assert.equal(claimed, true);
	assert.deepEqual(prepared, send);
	assert.equal(missing, null);
	await journal.drafts.saved(draft.operationId, original, "original revision");
	assert.deepEqual(await second.drafts.resolve(draft.operationId), original);
	const other = createOperationJournal("other@example.com", directory);
	assert.equal(await other.sends.get(send.operationId), null);
});
