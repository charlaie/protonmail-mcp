import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { GetMessageInput } from "../bridge/schemas.js";
import { createOperationDatabase } from "../operations/database.js";
import {
	assertDraftMutable,
	draftIdentityKey,
} from "../operations/draft-claims.js";
import { MailError } from "../shared/mail-error.js";
import { type InboxOperation, InboxOperationSchema } from "./model.js";

const RowSchema = z.object({ record: z.string() });
function read(db: DatabaseSync, id: string) {
	const row = db
		.prepare("SELECT record FROM inbox_operations WHERE id = ?")
		.get(id);
	return row
		? InboxOperationSchema.parse(JSON.parse(RowSchema.parse(row).record))
		: null;
}
export function createInboxStore(account: string, directory?: string) {
	const { use, transaction } = createOperationDatabase(account, directory);
	return {
		get: (id: string) => use((db) => read(db, id)),
		list: (limit: number, offset: number) =>
			use((db) =>
				db
					.prepare(
						"SELECT record FROM inbox_operations WHERE json_extract(record, '$.outcome.status') != 'completed' ORDER BY id LIMIT ? OFFSET ?",
					)
					.all(limit, offset)
					.map((row) =>
						InboxOperationSchema.parse(JSON.parse(RowSchema.parse(row).record)),
					),
			),
		uncertain: (id: string, reason: string) =>
			transaction((db) => {
				const record = read(db, id);
				if (!record)
					throw new MailError(
						"NOT_FOUND",
						"Inbox operation was not found for this account.",
						"never",
					);
				if (record.outcome.status !== "submitting") return record;
				const next = InboxOperationSchema.parse({
					...record,
					updatedAt: new Date().toISOString(),
					outcome: { status: "uncertain", reason },
				});
				db.prepare("UPDATE inbox_operations SET record = ? WHERE id = ?").run(
					JSON.stringify(next),
					id,
				);
				return next;
			}),
		claim: (record: InboxOperation) =>
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
				const key = assertDraftMutable(
					db,
					record.request,
					record.messageId ?? undefined,
				);
				const validated = InboxOperationSchema.parse(record);
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
				const record = read(db, id);
				if (!record)
					throw new MailError(
						"NOT_FOUND",
						"Inbox operation was not found for this account.",
						"never",
					);
				if (record.outcome.status === "completed") return record;
				const next = InboxOperationSchema.parse({
					...record,
					updatedAt: new Date().toISOString(),
					outcome: { status: "completed", destinationIdentity },
				});
				db.prepare("UPDATE inbox_operations SET record = ? WHERE id = ?").run(
					JSON.stringify(next),
					id,
				);
				db.prepare(
					"DELETE FROM inbox_claims WHERE identity = ? AND operation_id = ?",
				).run(draftIdentityKey(record.request), id);
				return next;
			}),
	};
}
export type InboxStore = ReturnType<typeof createInboxStore>;
