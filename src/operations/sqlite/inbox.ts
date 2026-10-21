import type { DatabaseSync } from "node:sqlite";
import type { GetMessageInput } from "../../mail/identity.js";
import {
	type InboxOperation,
	InboxOperationSchema,
} from "../../mail/inbox/model.js";
import { createOperationDatabase, type OperationDatabase } from "./database.js";
import { assertMessageMutable, messageIdentityKey } from "./message-claims.js";
import {
	isRecordedReplay,
	operationRecords,
	selectRecords,
} from "./records.js";

type InboxClaim = Omit<InboxOperation, "outcome">;

type FinalInboxOutcome = Extract<
	InboxOperation["outcome"],
	{ status: "completed" | "aborted" }
>;

const inboxRecords = operationRecords(
	"inbox_operations",
	InboxOperationSchema,
	"Inbox operation was not found for this account.",
);

const LIST_UNRESOLVED_INBOX_SQL =
	"SELECT record FROM inbox_operations WHERE json_extract(record, '$.outcome.status') IN ('reserved', 'submitting', 'uncertain') ORDER BY id LIMIT ? OFFSET ?";

function isFinal(record: InboxOperation) {
	return (
		record.outcome.status === "completed" || record.outcome.status === "aborted"
	);
}

function finish(
	db: DatabaseSync,
	record: InboxOperation,
	outcome: FinalInboxOutcome,
) {
	const finished = inboxRecords.save(db, { ...record, outcome });
	db.prepare(
		"DELETE FROM inbox_claims WHERE identity = ? AND operation_id = ?",
	).run(messageIdentityKey(record.request), record.operationId);
	return finished;
}

function claimMessage(db: DatabaseSync, claim: InboxClaim) {
	const existing = inboxRecords.read(db, claim.operationId);
	if (
		isRecordedReplay(
			existing,
			claim.requestHash,
			"Inbox operation ID belongs to another request.",
		)
	)
		return false;

	const key = assertMessageMutable(
		db,
		claim.request,
		claim.messageId ?? undefined,
	);
	const reserved = InboxOperationSchema.parse({
		...claim,
		outcome: { status: "reserved" },
	});
	db.prepare(
		"INSERT INTO inbox_claims (identity, operation_id) VALUES (?, ?)",
	).run(key, claim.operationId);
	db.prepare("INSERT INTO inbox_operations (id, record) VALUES (?, ?)").run(
		claim.operationId,
		JSON.stringify(reserved),
	);
	return true;
}

function startDispatch(db: DatabaseSync, id: string) {
	const record = inboxRecords.require(db, id);
	if (record.outcome.status !== "reserved") return false;
	inboxRecords.save(db, { ...record, outcome: { status: "submitting" } });
	return true;
}

function abortOperation(
	db: DatabaseSync,
	id: string,
	reason: string,
	expectedStatus: "reserved" | "submitting",
) {
	const record = inboxRecords.require(db, id);
	if (record.outcome.status !== expectedStatus) return record;
	return finish(db, record, { status: "aborted", reason });
}

function markUncertain(db: DatabaseSync, id: string, reason: string) {
	const record = inboxRecords.require(db, id);
	if (record.outcome.status !== "submitting") return record;
	return inboxRecords.save(db, {
		...record,
		outcome: { status: "uncertain", reason },
	});
}

function completeOperation(
	db: DatabaseSync,
	id: string,
	destinationIdentity: GetMessageInput | null,
) {
	const record = inboxRecords.require(db, id);
	if (isFinal(record)) return record;
	return finish(db, record, { status: "completed", destinationIdentity });
}

export function createInboxStore(account: string, directory?: string) {
	return createInboxJournal(createOperationDatabase(account, directory));
}

export function createInboxJournal({ use, transaction }: OperationDatabase) {
	return {
		get: (id: string) => use((db) => inboxRecords.read(db, id)),

		list: (limit: number, offset: number) =>
			use((db) =>
				selectRecords(
					db,
					InboxOperationSchema,
					LIST_UNRESOLVED_INBOX_SQL,
					limit,
					offset,
				),
			),

		dispatch: (id: string) => transaction((db) => startDispatch(db, id)),

		abort: (
			id: string,
			reason: string,
			expectedStatus: "reserved" | "submitting" = "reserved",
		) => transaction((db) => abortOperation(db, id, reason, expectedStatus)),

		uncertain: (id: string, reason: string) =>
			transaction((db) => markUncertain(db, id, reason)),

		claim: (record: InboxClaim) =>
			transaction((db) => claimMessage(db, record)),

		complete: (id: string, destinationIdentity: GetMessageInput | null) =>
			transaction((db) => completeOperation(db, id, destinationIdentity)),
	};
}

export type InboxStore = ReturnType<typeof createInboxStore>;
