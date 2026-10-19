import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import { z } from "zod";
import type { DraftOperation } from "../drafts/model.js";
import type { SendOperation } from "../sending/model.js";
import { createOperationJournal } from "./journal.js";

const account = "journal@example.com";
const original = { mailbox: "Drafts", uidValidity: "7", uid: 1 };
const replacement = { ...original, uid: 2 };
const RecordSchema = z.object({ record: z.string() });

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
		source: { kind: "email" },
		outcome: { status: "prepared" },
		draftCleanup: { status: "not_applicable" },
		sentCopies: [],
		createdAt: now,
		updatedAt: now,
	};
}

function withoutDraftIds(path: string) {
	const db = new DatabaseSync(path);
	try {
		db.exec(
			"UPDATE drafts SET record = json_remove(record, '$.draftId'); DROP TABLE draft_identities; DROP TABLE draft_identity_migrations; DROP INDEX drafts_by_logical_id;",
		);
	} finally {
		db.close();
	}
}

test("first access through sends migrates draft lineage before concurrent facets observe it", async (t) => {
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
	withoutDraftIds(journal.drafts.path);

	// A send-only startup must establish lineage, even without a draft request.
	const reopened = createOperationJournal(account, directory);
	assert.equal(await reopened.sends.get(randomUUID()), null);
	const db = new DatabaseSync(journal.drafts.path);
	try {
		const row = RecordSchema.parse(
			db
				.prepare("SELECT record FROM drafts WHERE id = ?")
				.get(edit.operationId),
		);
		assert.equal(JSON.parse(row.record).draftId, created.operationId);
	} finally {
		db.close();
	}

	const otherInstance = createOperationJournal(account, directory);
	const [resolved, migrated, missing] = await Promise.all([
		reopened.drafts.resolve(created.operationId),
		otherInstance.drafts.get(edit.operationId),
		reopened.inbox.get(randomUUID()),
	]);
	assert.deepEqual(resolved, replacement);
	assert.deepEqual(migrated, before);
	assert.equal(missing, null);
});

test("failed lineage migration rolls back and prevents claims until repaired, then the same journal retries", async (t) => {
	const { directory, journal } = await fixture(t);
	const draft = draftRecord();
	await journal.drafts.claim(draft);
	await journal.drafts.saved(draft.operationId, original, "original revision");
	withoutDraftIds(journal.drafts.path);
	const db = new DatabaseSync(journal.drafts.path);
	try {
		db.prepare(
			"INSERT INTO drafts (id, message_id, record) VALUES (?, ?, ?)",
		).run("corrupt", "<corrupt@example.com>", "{}");
	} finally {
		db.close();
	}

	const reopened = createOperationJournal(account, directory);
	const send = sendRecord();
	await assert.rejects(reopened.sends.prepare(send), {
		code: "STORAGE_FAILED",
	});
	await assert.rejects(reopened.inbox.get(randomUUID()), {
		code: "STORAGE_FAILED",
	});
	const repair = new DatabaseSync(journal.drafts.path);
	try {
		const row = RecordSchema.parse(
			repair
				.prepare("SELECT record FROM drafts WHERE id = ?")
				.get(draft.operationId),
		);
		assert.equal(JSON.parse(row.record).draftId, undefined);
		assert.equal(
			repair.prepare("SELECT 1 FROM sends WHERE id = ?").get(send.operationId),
			undefined,
		);
		repair.prepare("DELETE FROM drafts WHERE id = 'corrupt'").run();
	} finally {
		repair.close();
	}
	assert.deepEqual(await reopened.sends.prepare(send), send);
	assert.deepEqual(await reopened.drafts.resolve(draft.operationId), original);
	const anotherAccount = createOperationJournal("other@example.com", directory);
	assert.equal(await anotherAccount.sends.get(send.operationId), null);
});

test("concurrent account startup runs legacy migration once and keeps all facets usable", async (t) => {
	const { directory, journal } = await fixture(t);
	const draft = draftRecord();
	await journal.drafts.claim(draft);
	await journal.drafts.saved(draft.operationId, original, "original revision");
	withoutDraftIds(journal.drafts.path);
	const first = createOperationJournal(account, directory);
	const second = createOperationJournal(account, directory);
	const [missingSend, missingInbox, migrated] = await Promise.all([
		first.sends.get(randomUUID()),
		second.inbox.get(randomUUID()),
		first.drafts.get(draft.operationId),
	]);
	assert.equal(missingSend, null);
	assert.equal(missingInbox, null);
	assert.equal(migrated?.draftId, draft.operationId);
	assert.deepEqual(await second.drafts.resolve(draft.operationId), original);
});
