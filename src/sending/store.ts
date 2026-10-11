import { chmod, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { GetMessageInput } from "../bridge/schemas.js";
import { getPolicyFilePath } from "../policy/store.js";
import { MailError } from "../shared/mail-error.js";
import {
	type DraftCleanup,
	hashContent,
	type SendOperation,
	SendOperationSchema,
	type SmtpOutcome,
} from "./model.js";

const RowSchema = z.object({ record: z.string() });

export function createSendStore(
	account: string,
	directory = process.env.PROTONMAIL_MCP_OPERATIONS_DIR?.trim() ||
		join(dirname(getPolicyFilePath()), "send-operations"),
) {
	const path = join(directory, `${hashContent(account)}.sqlite`);
	async function use<T>(operation: (db: DatabaseSync) => T): Promise<T> {
		try {
			await mkdir(directory, { recursive: true, mode: 0o700 });
			const file = await open(path, "a", 0o600);
			await file.close();
			await chmod(path, 0o600);
			const db = new DatabaseSync(path);
			try {
				db.exec(
					"PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS sends (id TEXT PRIMARY KEY, record TEXT NOT NULL); CREATE TABLE IF NOT EXISTS draft_claims (identity TEXT PRIMARY KEY, operation_id TEXT NOT NULL);",
				);
				return operation(db);
			} finally {
				db.close();
			}
		} catch (error) {
			if (error instanceof MailError) throw error;
			throw new MailError(
				"STORAGE_FAILED",
				"Send journal could not be accessed. Do not resend an attempted operation; restore access and inspect its operation ID.",
				"configure",
				{ cause: error },
			);
		}
	}
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
	function transaction<T>(operation: (db: DatabaseSync) => T) {
		return use((db) => {
			db.exec("BEGIN IMMEDIATE");
			try {
				const result = operation(db);
				db.exec("COMMIT");
				return result;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		});
	}
	return {
		path,
		get: (id: string) => use((db) => read(db, id)),
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
					const key = hashContent({
						mailbox: stored.source.mailbox,
						uidValidity: stored.source.uidValidity,
						uid: stored.source.uid,
					});
					const owner = db
						.prepare("SELECT operation_id FROM draft_claims WHERE identity = ?")
						.get(key);
					if (owner) {
						const ownerId = z
							.object({ operation_id: z.string() })
							.parse(owner).operation_id;
						const previous = requireRecord(db, ownerId);
						if (
							previous.outcome.status !== "rejected" ||
							previous.sentCopies.length
						)
							throw new MailError(
								"OPERATION_CONFLICT",
								`This draft already has an attempted send ${ownerId}. Inspect that operation before considering another send.`,
								"reconcile",
							);
						db.prepare("DELETE FROM draft_claims WHERE identity = ?").run(key);
					}
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
				return stored.outcome.status === "accepted"
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
