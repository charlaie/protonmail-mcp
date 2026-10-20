import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
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

const RowSchema = z.object({ record: z.string() });

export function createSendStore(account: string, directory?: string) {
	return createSendJournal(createOperationDatabase(account, directory));
}

export function createSendJournal({
	path,
	use,
	transaction,
}: OperationDatabase) {
	function read(db: DatabaseSync, id: string) {
		const row = db.prepare("SELECT record FROM sends WHERE id = ?").get(id);
		return row
			? SendOperationSchema.parse(JSON.parse(RowSchema.parse(row).record))
			: null;
	}
	function requireRecord(db: DatabaseSync, id: string) {
		const record = read(db, id);
		if (!record)
			throw new MailError(
				"NOT_FOUND",
				"Send operation was not found for this account.",
				"never",
			);
		return record;
	}
	function save(db: DatabaseSync, record: SendOperation) {
		const next = SendOperationSchema.parse({
			...record,
			updatedAt: new Date().toISOString(),
		});
		db.prepare("UPDATE sends SET record = ? WHERE id = ?").run(
			JSON.stringify(next),
			next.operationId,
		);
		return next;
	}
	return {
		path,
		get: (id: string) => use((db) => read(db, id)),
		list: (limit: number, offset: number) =>
			use((db) =>
				db
					.prepare(
						"SELECT record FROM sends WHERE json_extract(record, '$.outcome.status') IN ('prepared', 'submitting', 'uncertain', 'partially_accepted') OR (json_extract(record, '$.outcome.status') = 'accepted' AND json_extract(record, '$.draftCleanup.status') IN ('pending', 'failed', 'retained')) ORDER BY id LIMIT ? OFFSET ?",
					)
					.all(limit, offset)
					.map((row) =>
						SendOperationSchema.parse(JSON.parse(RowSchema.parse(row).record)),
					),
			),
		prepare: (record: SendOperation) =>
			transaction((db) => {
				const validated = SendOperationSchema.parse(record);
				db.prepare(
					"INSERT OR IGNORE INTO sends (id, record) VALUES (?, ?)",
				).run(validated.operationId, JSON.stringify(validated));
				const stored = requireRecord(db, validated.operationId);
				if (
					stored.requestHash !== validated.requestHash ||
					stored.contentHash !== validated.contentHash
				)
					throw new MailError(
						"OPERATION_CONFLICT",
						"This operation ID is already bound to a different request or draft snapshot. Review the change and use a new ID; never change IDs to retry uncertain delivery.",
						"new_approval",
					);
				return stored;
			}),
		claim: (id: string, contentHash: string) =>
			transaction((db) => {
				const stored = requireRecord(db, id);
				if (stored.outcome.status !== "prepared") return false;
				if (stored.contentHash !== contentHash)
					throw new MailError(
						"OPERATION_CONFLICT",
						"Persisted send content differs from the approved snapshot.",
						"never",
					);
				if (stored.source.kind === "draft") {
					const key = assertMessageMutable(
						db,
						stored.source,
						stored.source.draftMessageId,
					);
					db.prepare("DELETE FROM draft_claims WHERE identity = ?").run(key);
					db.prepare(
						"INSERT INTO draft_claims (identity, operation_id) VALUES (?, ?)",
					).run(key, id);
				}
				save(db, { ...stored, outcome: { status: "submitting" } });
				return true;
			}),
		finish: (id: string, outcome: SmtpOutcome) =>
			transaction((db) => {
				const stored = requireRecord(db, id);
				if (stored.outcome.status !== "submitting") return stored;
				return save(db, {
					...stored,
					outcome,
					draftCleanup:
						stored.source.kind === "draft" && outcome.status !== "accepted"
							? {
									status: "retained",
									reason:
										"Submission was not fully confirmed for all recipients. Inspect this operation before changing or sending the retained draft.",
								}
							: stored.draftCleanup,
				});
			}),
		updateCleanup: (id: string, draftCleanup: DraftCleanup) =>
			transaction((db) => {
				const stored = requireRecord(db, id);
				return stored.outcome.status === "accepted" &&
					stored.draftCleanup.status !== "deleted"
					? save(db, { ...stored, draftCleanup })
					: stored;
			}),
		reconcile: (id: string, matches: GetMessageInput[]) =>
			transaction((db) => {
				const stored = requireRecord(db, id);
				return matches.length
					? save(db, { ...stored, sentCopies: matches })
					: stored;
			}),
	};
}
export type SendStore = ReturnType<typeof createSendStore>;
