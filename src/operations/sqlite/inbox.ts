import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { GetMessageInput } from "../../mail/identity.js";
import {
	type InboxOperation,
	InboxOperationSchema,
} from "../../mail/inbox/model.js";
import { MailError } from "../../shared/mail-error.js";
import { createOperationDatabase, type OperationDatabase } from "./database.js";
import { assertMessageMutable, messageIdentityKey } from "./message-claims.js";

const RowSchema = z.object({ record: z.string() });
function read(db: DatabaseSync, id: string) {
	const row = db
		.prepare("SELECT record FROM inbox_operations WHERE id = ?")
		.get(id);
	return row
		? InboxOperationSchema.parse(JSON.parse(RowSchema.parse(row).record))
		: null;
}
function requireRecord(db: DatabaseSync, id: string) {
	const record = read(db, id);
	if (!record)
		throw new MailError(
			"NOT_FOUND",
			"Inbox operation was not found for this account.",
			"never",
		);
	return record;
}
function save(db: DatabaseSync, record: InboxOperation) {
	const next = InboxOperationSchema.parse({
		...record,
		updatedAt: new Date().toISOString(),
	});
	db.prepare("UPDATE inbox_operations SET record = ? WHERE id = ?").run(
		JSON.stringify(next),
		next.operationId,
	);
	return next;
}
function finish(
	db: DatabaseSync,
	record: InboxOperation,
	outcome: Extract<
		InboxOperation["outcome"],
		{ status: "completed" | "aborted" }
	>,
) {
	const next = save(db, { ...record, outcome });
	db.prepare(
		"DELETE FROM inbox_claims WHERE identity = ? AND operation_id = ?",
	).run(messageIdentityKey(record.request), record.operationId);
	return next;
}
export function createInboxStore(account: string, directory?: string) {
	return createInboxJournal(createOperationDatabase(account, directory));
}

export function createInboxJournal({ use, transaction }: OperationDatabase) {
	return {
		get: (id: string) => use((db) => read(db, id)),
		list: (limit: number, offset: number) =>
			use((db) =>
				db
					.prepare(
						"SELECT record FROM inbox_operations WHERE json_extract(record, '$.outcome.status') IN ('reserved', 'submitting', 'uncertain') ORDER BY id LIMIT ? OFFSET ?",
					)
					.all(limit, offset)
					.map((row) =>
						InboxOperationSchema.parse(JSON.parse(RowSchema.parse(row).record)),
					),
			),
		dispatch: (id: string) =>
			transaction((db) => {
				const record = requireRecord(db, id);
				if (record.outcome.status !== "reserved") return false;
				save(db, { ...record, outcome: { status: "submitting" } });
				return true;
			}),
		abort: (
			id: string,
			reason: string,
			expectedStatus: "reserved" | "submitting" = "reserved",
		) =>
			transaction((db) => {
				const record = requireRecord(db, id);
				return record.outcome.status === expectedStatus
					? finish(db, record, { status: "aborted", reason })
					: record;
			}),
		uncertain: (id: string, reason: string) =>
			transaction((db) => {
				const record = requireRecord(db, id);
				return record.outcome.status === "submitting"
					? save(db, { ...record, outcome: { status: "uncertain", reason } })
					: record;
			}),
		claim: (record: Omit<InboxOperation, "outcome">) =>
			transaction((db) => {
				const existing = read(db, record.operationId);
				if (existing) {
					if (existing.requestHash !== record.requestHash)
						throw new MailError(
							"OPERATION_CONFLICT",
							"Inbox operation ID belongs to another request.",
							"never",
						);
					return false;
				}
				const key = assertMessageMutable(
					db,
					record.request,
					record.messageId ?? undefined,
				);
				const validated = InboxOperationSchema.parse({
					...record,
					outcome: { status: "reserved" },
				});
				db.prepare(
					"INSERT INTO inbox_claims (identity, operation_id) VALUES (?, ?)",
				).run(key, record.operationId);
				db.prepare(
					"INSERT INTO inbox_operations (id, record) VALUES (?, ?)",
				).run(record.operationId, JSON.stringify(validated));
				return true;
			}),
		complete: (id: string, destinationIdentity: GetMessageInput | null) =>
			transaction((db) => {
				const record = requireRecord(db, id);
				return record.outcome.status === "completed" ||
					record.outcome.status === "aborted"
					? record
					: finish(db, record, { status: "completed", destinationIdentity });
			}),
	};
}
export type InboxStore = ReturnType<typeof createInboxStore>;
