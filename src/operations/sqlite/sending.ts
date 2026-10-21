import type { DatabaseSync } from "node:sqlite";
import type { GetMessageInput } from "../../mail/identity.js";
import {
	type DraftCleanup,
	type SendOperation,
	SendOperationSchema,
	type SmtpOutcome,
} from "../../mail/sending/model.js";
import { MailError } from "../../shared/mail-error.js";
import { createOperationDatabase, type OperationDatabase } from "./database.js";
import { assertMessageMutable } from "./message-claims.js";
import { operationRecords, selectRecords } from "./records.js";

type DraftSendSource = Extract<SendOperation["source"], { kind: "draft" }>;

const sendRecords = operationRecords(
	"sends",
	SendOperationSchema,
	"Send operation was not found for this account.",
);

const LIST_UNRESOLVED_SENDS_SQL =
	"SELECT record FROM sends WHERE json_extract(record, '$.outcome.status') IN ('prepared', 'submitting', 'uncertain', 'partially_accepted') OR (json_extract(record, '$.outcome.status') = 'accepted' AND json_extract(record, '$.draftCleanup.status') IN ('pending', 'failed', 'retained')) ORDER BY id LIMIT ? OFFSET ?";

const RETAINED_DRAFT_CLEANUP: DraftCleanup = {
	status: "retained",
	reason:
		"Submission was not fully confirmed for all recipients. Inspect this operation before changing or sending the retained draft.",
};

function prepareSend(db: DatabaseSync, record: SendOperation) {
	const prepared = SendOperationSchema.parse(record);
	db.prepare("INSERT OR IGNORE INTO sends (id, record) VALUES (?, ?)").run(
		prepared.operationId,
		JSON.stringify(prepared),
	);

	const stored = sendRecords.require(db, prepared.operationId);
	if (
		stored.requestHash !== prepared.requestHash ||
		stored.contentHash !== prepared.contentHash
	)
		throw new MailError(
			"OPERATION_CONFLICT",
			"This operation ID is already bound to a different request or draft snapshot. Review the change and use a new ID; never change IDs to retry uncertain delivery.",
			"new_approval",
		);
	return stored;
}

function claimSourceDraft(
	db: DatabaseSync,
	source: DraftSendSource,
	operationId: string,
) {
	const key = assertMessageMutable(db, source, source.draftMessageId);
	// A claim left by a rejected send without sent copies may be replaced.
	db.prepare("DELETE FROM draft_claims WHERE identity = ?").run(key);
	db.prepare(
		"INSERT INTO draft_claims (identity, operation_id) VALUES (?, ?)",
	).run(key, operationId);
}

function claimSubmission(db: DatabaseSync, id: string, contentHash: string) {
	const stored = sendRecords.require(db, id);
	if (stored.outcome.status !== "prepared") return false;
	if (stored.contentHash !== contentHash)
		throw new MailError(
			"OPERATION_CONFLICT",
			"Persisted send content differs from the approved snapshot.",
			"never",
		);

	if (stored.source.kind === "draft") claimSourceDraft(db, stored.source, id);
	sendRecords.save(db, { ...stored, outcome: { status: "submitting" } });
	return true;
}

function finishSubmission(db: DatabaseSync, id: string, outcome: SmtpOutcome) {
	const stored = sendRecords.require(db, id);
	if (stored.outcome.status !== "submitting") return stored;

	const retainsDraft =
		stored.source.kind === "draft" && outcome.status !== "accepted";
	return sendRecords.save(db, {
		...stored,
		outcome,
		draftCleanup: retainsDraft ? RETAINED_DRAFT_CLEANUP : stored.draftCleanup,
	});
}

function updateDraftCleanup(
	db: DatabaseSync,
	id: string,
	draftCleanup: DraftCleanup,
) {
	const stored = sendRecords.require(db, id);
	if (
		stored.outcome.status !== "accepted" ||
		stored.draftCleanup.status === "deleted"
	)
		return stored;
	return sendRecords.save(db, { ...stored, draftCleanup });
}

function recordSentCopies(
	db: DatabaseSync,
	id: string,
	matches: GetMessageInput[],
) {
	const stored = sendRecords.require(db, id);
	if (matches.length === 0) return stored;
	return sendRecords.save(db, { ...stored, sentCopies: matches });
}

export function createSendStore(account: string, directory?: string) {
	return createSendJournal(createOperationDatabase(account, directory));
}

export function createSendJournal({
	path,
	use,
	transaction,
}: OperationDatabase) {
	return {
		path,

		get: (id: string) => use((db) => sendRecords.read(db, id)),

		list: (limit: number, offset: number) =>
			use((db) =>
				selectRecords(
					db,
					SendOperationSchema,
					LIST_UNRESOLVED_SENDS_SQL,
					limit,
					offset,
				),
			),

		prepare: (record: SendOperation) =>
			transaction((db) => prepareSend(db, record)),

		claim: (id: string, contentHash: string) =>
			transaction((db) => claimSubmission(db, id, contentHash)),

		finish: (id: string, outcome: SmtpOutcome) =>
			transaction((db) => finishSubmission(db, id, outcome)),

		updateCleanup: (id: string, draftCleanup: DraftCleanup) =>
			transaction((db) => updateDraftCleanup(db, id, draftCleanup)),

		reconcile: (id: string, matches: GetMessageInput[]) =>
			transaction((db) => recordSentCopies(db, id, matches)),
	};
}

export type SendStore = ReturnType<typeof createSendStore>;
