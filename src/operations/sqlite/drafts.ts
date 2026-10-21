import type { DatabaseSync } from "node:sqlite";
import {
	type DraftOperation,
	DraftOperationSchema,
} from "@/mail/drafts/model.js";
import type { GetMessageInput } from "@/mail/identity.js";
import { createOperationDatabase, type OperationDatabase } from "./database.js";
import {
	bindDraftIdentity,
	type DraftSnapshotEvidence,
	identifyDraft,
	identifyDraftSnapshot,
	requireUnusedDraftId,
	resolveDraftIdentity,
} from "./draft-identities.js";
import { assertMessageMutable, messageIdentityKey } from "./message-claims.js";
import {
	isRecordedReplay,
	operationRecords,
	selectRecords,
} from "./records.js";

type DraftClaim = Omit<DraftOperation, "draftId">;

type EditedDraftSource = Extract<DraftOperation["source"], { kind: "edit" }>;

type DraftCleanupResult =
	| { status: "completed" }
	| { status: "cleanup_failed"; reason: string };

const draftRecords = operationRecords(
	"drafts",
	DraftOperationSchema,
	"Draft operation was not found.",
);

const LIST_OPEN_DRAFTS_SQL =
	"SELECT record FROM drafts WHERE json_extract(record, '$.outcome.status') IN ('appending', 'saved', 'cleanup_failed') ORDER BY id LIMIT ? OFFSET ?";

function reserveEditedDraft(
	db: DatabaseSync,
	source: EditedDraftSource,
	operationId: string,
	sourceMessageId: string | undefined,
) {
	assertMessageMutable(db, source, sourceMessageId);
	db.prepare(
		"INSERT INTO draft_mutations (identity, operation_id) VALUES (?, ?)",
	).run(messageIdentityKey(source), operationId);
}

function releaseEditedDraft(
	db: DatabaseSync,
	source: EditedDraftSource,
	operationId: string,
) {
	db.prepare(
		"DELETE FROM draft_mutations WHERE identity = ? AND operation_id = ?",
	).run(messageIdentityKey(source), operationId);
}

function logicalDraftId(db: DatabaseSync, claim: DraftClaim) {
	if (claim.source.kind === "edit")
		return identifyDraft(db, claim.source, claim.operationId);
	return requireUnusedDraftId(db, claim.operationId);
}

function claimDraft(
	db: DatabaseSync,
	claim: DraftClaim,
	sourceMessageId: string | undefined,
) {
	const existing = draftRecords.read(db, claim.operationId);
	if (
		isRecordedReplay(
			existing,
			claim.requestHash,
			"Draft operation ID belongs to another request.",
		)
	)
		return false;

	if (claim.source.kind === "edit")
		reserveEditedDraft(db, claim.source, claim.operationId, sourceMessageId);

	const record = DraftOperationSchema.parse({
		...claim,
		draftId: logicalDraftId(db, claim),
	});
	db.prepare(
		"INSERT INTO drafts (id, message_id, record) VALUES (?, ?, ?)",
	).run(record.operationId, record.messageId, JSON.stringify(record));
	return true;
}

function rejectDraft(db: DatabaseSync, id: string, reason: string) {
	const record = draftRecords.require(db, id);
	if (record.outcome.status !== "appending") return record;

	const rejected = draftRecords.save(db, {
		...record,
		outcome: { status: "rejected", reason },
	});
	if (record.source.kind === "edit") releaseEditedDraft(db, record.source, id);
	return rejected;
}

function recordSavedDraft(
	db: DatabaseSync,
	id: string,
	identity: GetMessageInput,
	revision: string,
) {
	const record = draftRecords.require(db, id);
	if (record.outcome.status !== "appending") return record;

	bindDraftIdentity(db, identity, record.draftId);
	const status = record.source.kind === "create" ? "completed" : "saved";
	return draftRecords.save(db, {
		...record,
		outcome: { status, identity, revision },
	});
}

function recordDraftCleanup(
	db: DatabaseSync,
	id: string,
	result: DraftCleanupResult,
) {
	const record = draftRecords.require(db, id);
	const { outcome } = record;
	if (outcome.status !== "saved" && outcome.status !== "cleanup_failed")
		return record;

	return draftRecords.save(db, {
		...record,
		outcome: {
			...result,
			identity: outcome.identity,
			revision: outcome.revision,
		},
	});
}

export function createDraftStore(account: string, directory?: string) {
	return createDraftJournal(createOperationDatabase(account, directory));
}

export function createDraftJournal({
	path,
	use,
	transaction,
}: OperationDatabase) {
	return {
		path,

		get: (id: string) => use((db) => draftRecords.read(db, id)),

		identify: (identity: GetMessageInput, evidence: DraftSnapshotEvidence) =>
			transaction((db) => identifyDraftSnapshot(db, identity, evidence)),

		resolve: (draftId: string) =>
			use((db) => resolveDraftIdentity(db, draftId)),

		list: (limit: number, offset: number) =>
			use((db) =>
				selectRecords(
					db,
					DraftOperationSchema,
					LIST_OPEN_DRAFTS_SQL,
					limit,
					offset,
				),
			),

		claim: (record: DraftClaim, sourceMessageId?: string) =>
			transaction((db) => claimDraft(db, record, sourceMessageId)),

		reject: (id: string, reason: string) =>
			transaction((db) => rejectDraft(db, id, reason)),

		saved: (id: string, identity: GetMessageInput, revision: string) =>
			transaction((db) => recordSavedDraft(db, id, identity, revision)),

		cleanup: (id: string, result: DraftCleanupResult) =>
			transaction((db) => recordDraftCleanup(db, id, result)),
	};
}

export type DraftStore = ReturnType<typeof createDraftStore>;
