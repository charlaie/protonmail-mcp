import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { GetMessageInput } from "../bridge/schemas.js";
import { createOperationDatabase } from "../operations/database.js";
import {
	assertMessageMutable,
	messageIdentityKey,
} from "../operations/message-claims.js";
import { MailError } from "../shared/mail-error.js";
import { type DraftOperation, DraftOperationSchema } from "./model.js";

const RowSchema = z.object({ record: z.string() });
function read(db: DatabaseSync, id: string) {
	const row = db.prepare("SELECT record FROM drafts WHERE id = ?").get(id);
	return row
		? DraftOperationSchema.parse(JSON.parse(RowSchema.parse(row).record))
		: null;
}
export function createDraftStore(account: string, directory?: string) {
	const { path, use, transaction } = createOperationDatabase(
		account,
		directory,
	);
	function save(db: DatabaseSync, record: DraftOperation) {
		const validated = DraftOperationSchema.parse({
			...record,
			updatedAt: new Date().toISOString(),
		});
		db.prepare("UPDATE drafts SET record = ? WHERE id = ?").run(
			JSON.stringify(validated),
			validated.operationId,
		);
		return validated;
	}
	return {
		path,
		get: (id: string) => use((db) => read(db, id)),
		list: (limit: number, offset: number) =>
			use((db) =>
				db
					.prepare(
						"SELECT record FROM drafts WHERE json_extract(record, '$.outcome.status') IN ('appending', 'saved', 'cleanup_failed') ORDER BY id LIMIT ? OFFSET ?",
					)
					.all(limit, offset)
					.map((row) =>
						DraftOperationSchema.parse(JSON.parse(RowSchema.parse(row).record)),
					),
			),
		claim: (record: DraftOperation, sourceMessageId?: string) =>
			transaction((db) => {
				const existing = read(db, record.operationId);
				if (existing) {
					if (existing.requestHash !== record.requestHash)
						throw new MailError(
							"OPERATION_CONFLICT",
							"Draft operation ID belongs to another request.",
							"never",
						);
					return false;
				}
				if (record.source.kind === "edit") {
					assertMessageMutable(db, record.source, sourceMessageId);
					db.prepare(
						"INSERT INTO draft_mutations (identity, operation_id) VALUES (?, ?)",
					).run(messageIdentityKey(record.source), record.operationId);
				}
				const validated = DraftOperationSchema.parse(record);
				db.prepare(
					"INSERT INTO drafts (id, message_id, record) VALUES (?, ?, ?)",
				).run(
					validated.operationId,
					validated.messageId,
					JSON.stringify(validated),
				);
				return true;
			}),
		reject: (id: string, reason: string) =>
			transaction((db) => {
				const record = read(db, id);
				if (!record)
					throw new MailError(
						"NOT_FOUND",
						"Draft operation was not found.",
						"never",
					);
				if (record.outcome.status !== "appending") return record;
				const next = save(db, {
					...record,
					outcome: { status: "rejected", reason },
				});
				if (record.source.kind === "edit")
					db.prepare(
						"DELETE FROM draft_mutations WHERE identity = ? AND operation_id = ?",
					).run(messageIdentityKey(record.source), id);
				return next;
			}),
		saved: (id: string, identity: GetMessageInput, revision: string) =>
			transaction((db) => {
				const record = read(db, id);
				if (!record)
					throw new MailError(
						"NOT_FOUND",
						"Draft operation was not found.",
						"never",
					);
				if (record.outcome.status !== "appending") return record;
				return save(db, {
					...record,
					outcome: {
						status: record.source.kind === "create" ? "completed" : "saved",
						identity,
						revision,
					},
				});
			}),
		cleanup: (
			id: string,
			result:
				| { status: "completed" }
				| { status: "cleanup_failed"; reason: string },
		) =>
			transaction((db) => {
				const record = read(db, id);
				if (!record)
					throw new MailError(
						"NOT_FOUND",
						"Draft operation was not found.",
						"never",
					);
				if (
					record.outcome.status === "appending" ||
					record.outcome.status === "rejected" ||
					record.outcome.status === "completed"
				)
					return record;
				return save(db, {
					...record,
					outcome: {
						...result,
						identity: record.outcome.identity,
						revision: record.outcome.revision,
					},
				});
			}),
	};
}
export type DraftStore = ReturnType<typeof createDraftStore>;
