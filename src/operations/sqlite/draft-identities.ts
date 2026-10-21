import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
	type DraftOperation,
	DraftOperationSchema,
	StoredDraftOperationSchema,
} from "../../mail/drafts/model.js";
import { type GetMessageInput, GetMessageSchema } from "../../mail/identity.js";
import { MailError } from "../../shared/mail-error.js";
import { messageIdentityKey } from "./message-claims.js";
import { selectRecord, selectRecords } from "./records.js";

export type DraftSnapshotEvidence = {
	messageId?: string;
	contentHash: DraftOperation["contentHash"];
};

type StoredDraftOperation = z.infer<typeof StoredDraftOperationSchema>;

const BindingSchema = z.object({ draft_id: z.uuid() });

const DRAFT_IDENTITY_SCHEMA = [
	"CREATE TABLE IF NOT EXISTS draft_identities (identity TEXT PRIMARY KEY, draft_id TEXT NOT NULL, record TEXT NOT NULL);",
	"CREATE INDEX IF NOT EXISTS draft_identities_by_id ON draft_identities (draft_id);",
	"CREATE INDEX IF NOT EXISTS drafts_by_logical_id ON drafts (json_extract(record, '$.draftId'));",
	"CREATE TABLE IF NOT EXISTS draft_identity_migrations (version INTEGER PRIMARY KEY);",
].join(" ");

function boundDraftId(db: DatabaseSync, identityKey: string) {
	const binding = db
		.prepare("SELECT draft_id FROM draft_identities WHERE identity = ?")
		.get(identityKey);
	return binding ? BindingSchema.parse(binding).draft_id : undefined;
}

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
	const existingDraftId = boundDraftId(db, key);
	if (existingDraftId !== undefined && existingDraftId !== draftId)
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
	const existingDraftId = boundDraftId(db, messageIdentityKey(identity));
	if (existingDraftId !== undefined) return existingDraftId;
	return bindDraftIdentity(db, identity, requireUnusedDraftId(db, fallback));
}

export function identifyDraftSnapshot(
	db: DatabaseSync,
	identity: GetMessageInput,
	evidence: DraftSnapshotEvidence,
) {
	const appended = evidence.messageId
		? selectRecord(
				db,
				DraftOperationSchema,
				"SELECT record FROM drafts WHERE message_id = ?",
				evidence.messageId,
			)
		: null;
	// An APPEND awaiting its result owns the snapshot it wrote.
	if (
		appended &&
		appended.contentHash === evidence.contentHash &&
		appended.outcome.status === "appending"
	)
		return bindDraftIdentity(db, identity, appended.draftId);
	return identifyDraft(db, identity);
}

export function draftIdentitiesReady(db: DatabaseSync) {
	const migrationTable = db
		.prepare(
			"SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'draft_identity_migrations'",
		)
		.get();
	if (!migrationTable) return false;
	return Boolean(
		db
			.prepare("SELECT 1 FROM draft_identity_migrations WHERE version = 1")
			.get(),
	);
}

function migrateDraftRecord(db: DatabaseSync, record: StoredDraftOperation) {
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

// Run once inside a transaction. Existing outcomes and replay hashes stay intact.
export function migrateDraftIdentities(db: DatabaseSync) {
	if (draftIdentitiesReady(db)) return;

	db.exec(DRAFT_IDENTITY_SCHEMA);
	const unmigrated = selectRecords(
		db,
		StoredDraftOperationSchema,
		"SELECT record FROM drafts WHERE json_extract(record, '$.draftId') IS NULL ORDER BY rowid",
	);
	for (const record of unmigrated) migrateDraftRecord(db, record);
	db.prepare(
		"INSERT INTO draft_identity_migrations (version) VALUES (1)",
	).run();
}

export function resolveDraftIdentity(db: DatabaseSync, draftId: string) {
	const latest = selectRecord(
		db,
		DraftOperationSchema,
		"SELECT record FROM drafts WHERE json_extract(record, '$.draftId') = ? AND json_extract(record, '$.outcome.status') != 'rejected' ORDER BY rowid DESC LIMIT 1",
		draftId,
	);
	if (latest) {
		if (!("identity" in latest.outcome))
			throw new MailError(
				"OPERATION_BUSY",
				`Draft has an unresolved replacement. Inspect and reconcile draft operation ${latest.operationId} before resolving its current identity.`,
				"reconcile",
			);
		return latest.outcome.identity;
	}

	// Before the first APPEND there is exactly one adopted physical identity.
	const adopted = selectRecord(
		db,
		GetMessageSchema,
		"SELECT record FROM draft_identities WHERE draft_id = ? LIMIT 1",
		draftId,
	);
	if (!adopted)
		throw new MailError(
			"NOT_FOUND",
			"Logical draft ID was not found in this account's journal.",
			"never",
		);
	return adopted;
}
