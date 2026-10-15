import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { type GetMessageInput, GetMessageSchema } from "../bridge/schemas.js";
import { messageIdentityKey } from "../operations/message-claims.js";
import { MailError } from "../shared/mail-error.js";
import type { DraftOperation } from "./model.js";
import { DraftOperationSchema, StoredDraftOperationSchema } from "./model.js";

const BindingSchema = z.object({ draft_id: z.uuid() });
const RecordSchema = z.object({ record: z.string() });

export function requireUnusedDraftId(db: DatabaseSync, draftId: string) {
	const binding = db
		.prepare("SELECT 1 FROM draft_identities WHERE draft_id = ? LIMIT 1")
		.get(draftId);
	const operation = db
		.prepare(
			"SELECT 1 FROM drafts WHERE json_extract(record, '$.draftId') = ? LIMIT 1",
		)
		.get(draftId);
	if (binding || operation)
		throw new MailError(
			"OPERATION_CONFLICT",
			"This operation UUID is already a logical draft ID. Use a fresh operation UUID for the new draft.",
			"never",
		);
	return draftId;
}

export function bindDraftIdentity(
	db: DatabaseSync,
	identity: GetMessageInput,
	draftId: string,
) {
	const key = messageIdentityKey(identity);
	const existing = db
		.prepare("SELECT draft_id FROM draft_identities WHERE identity = ?")
		.get(key);
	if (existing && BindingSchema.parse(existing).draft_id !== draftId)
		throw new MailError(
			"OPERATION_CONFLICT",
			"This IMAP identity already belongs to another logical draft.",
			"reconcile",
		);
	db.prepare(
		"INSERT OR IGNORE INTO draft_identities (identity, draft_id, record) VALUES (?, ?, ?)",
	).run(key, draftId, JSON.stringify(GetMessageSchema.parse(identity)));
	return draftId;
}

export function identifyDraft(
	db: DatabaseSync,
	identity: GetMessageInput,
	fallback: string = randomUUID(),
) {
	const row = db
		.prepare("SELECT draft_id FROM draft_identities WHERE identity = ?")
		.get(messageIdentityKey(identity));
	if (row) return BindingSchema.parse(row).draft_id;
	return bindDraftIdentity(db, identity, requireUnusedDraftId(db, fallback));
}

export function identifyDraftSnapshot(
	db: DatabaseSync,
	identity: GetMessageInput,
	evidence: { messageId?: string; contentHash: DraftOperation["contentHash"] },
) {
	const row = evidence.messageId
		? db
				.prepare("SELECT record FROM drafts WHERE message_id = ?")
				.get(evidence.messageId)
		: undefined;
	if (row) {
		const operation = DraftOperationSchema.parse(
			JSON.parse(RecordSchema.parse(row).record),
		);
		if (
			operation.contentHash === evidence.contentHash &&
			operation.outcome.status === "appending"
		)
			return bindDraftIdentity(db, identity, operation.draftId);
	}
	return identifyDraft(db, identity);
}

export function draftIdentitiesReady(db: DatabaseSync) {
	const table = db
		.prepare(
			"SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'draft_identity_migrations'",
		)
		.get();
	return Boolean(
		table &&
			db
				.prepare("SELECT 1 FROM draft_identity_migrations WHERE version = 1")
				.get(),
	);
}

// Run once inside a transaction. Existing outcomes and replay hashes stay intact.
export function migrateDraftIdentities(db: DatabaseSync) {
	if (draftIdentitiesReady(db)) return;
	db.exec(
		"CREATE TABLE IF NOT EXISTS draft_identities (identity TEXT PRIMARY KEY, draft_id TEXT NOT NULL, record TEXT NOT NULL); CREATE INDEX IF NOT EXISTS draft_identities_by_id ON draft_identities (draft_id); CREATE INDEX IF NOT EXISTS drafts_by_logical_id ON drafts (json_extract(record, '$.draftId')); CREATE TABLE IF NOT EXISTS draft_identity_migrations (version INTEGER PRIMARY KEY);",
	);
	for (const row of db
		.prepare(
			"SELECT record FROM drafts WHERE json_extract(record, '$.draftId') IS NULL ORDER BY rowid",
		)
		.all()) {
		const record = StoredDraftOperationSchema.parse(
			JSON.parse(RecordSchema.parse(row).record),
		);
		const draftId =
			record.source.kind === "edit"
				? identifyDraft(db, record.source, record.operationId)
				: record.operationId;
		const migrated = DraftOperationSchema.parse({ ...record, draftId });
		if ("identity" in migrated.outcome)
			bindDraftIdentity(db, migrated.outcome.identity, draftId);
		db.prepare("UPDATE drafts SET record = ? WHERE id = ?").run(
			JSON.stringify(migrated),
			record.operationId,
		);
	}
	db.prepare(
		"INSERT INTO draft_identity_migrations (version) VALUES (1)",
	).run();
}

export function resolveDraftIdentity(db: DatabaseSync, draftId: string) {
	const row = db
		.prepare(
			"SELECT record FROM drafts WHERE json_extract(record, '$.draftId') = ? AND json_extract(record, '$.outcome.status') != 'rejected' ORDER BY rowid DESC LIMIT 1",
		)
		.get(draftId);
	if (row) {
		const operation = DraftOperationSchema.parse(
			JSON.parse(RecordSchema.parse(row).record),
		);
		if (!("identity" in operation.outcome))
			throw new MailError(
				"OPERATION_BUSY",
				`Draft has an unresolved replacement. Inspect and reconcile draft operation ${operation.operationId} before resolving its current identity.`,
				"reconcile",
			);
		return operation.outcome.identity;
	}
	const binding = db
		.prepare("SELECT record FROM draft_identities WHERE draft_id = ? LIMIT 1")
		.get(draftId);
	if (!binding)
		throw new MailError(
			"NOT_FOUND",
			"Logical draft ID was not found in this account's journal.",
			"never",
		);
	// Before the first APPEND there is exactly one adopted physical identity.
	return GetMessageSchema.parse(JSON.parse(RecordSchema.parse(binding).record));
}
