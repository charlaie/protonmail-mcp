import { chmod, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getPolicyFilePath } from "@/policy/store.js";
import { hashContent } from "@/shared/content-hash.js";
import { MailError } from "@/shared/mail-error.js";
import {
	draftIdentitiesReady,
	migrateDraftIdentities,
} from "./draft-identities.js";

function transact<T>(db: DatabaseSync, operation: (db: DatabaseSync) => T) {
	db.exec("BEGIN IMMEDIATE");
	try {
		const result = operation(db);
		db.exec("COMMIT");
		return result;
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

export function createOperationDatabase(
	account: string,
	directory = join(dirname(getPolicyFilePath()), "send-operations"),
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
					"PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS sends (id TEXT PRIMARY KEY, record TEXT NOT NULL); CREATE TABLE IF NOT EXISTS draft_claims (identity TEXT PRIMARY KEY, operation_id TEXT NOT NULL); CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, message_id TEXT UNIQUE NOT NULL, record TEXT NOT NULL); CREATE TABLE IF NOT EXISTS draft_mutations (identity TEXT PRIMARY KEY, operation_id TEXT NOT NULL); CREATE TABLE IF NOT EXISTS inbox_operations (id TEXT PRIMARY KEY, record TEXT NOT NULL); CREATE TABLE IF NOT EXISTS inbox_claims (identity TEXT PRIMARY KEY, operation_id TEXT NOT NULL);",
				);
				// Every facet must observe migrated lineage before inspecting claims.
				if (!draftIdentitiesReady(db)) transact(db, migrateDraftIdentities);
				return operation(db);
			} finally {
				db.close();
			}
		} catch (error) {
			if (error instanceof MailError) throw error;
			throw new MailError(
				"STORAGE_FAILED",
				"Operation journal could not be accessed. Restore access and inspect the operation ID before retrying any attempted write.",
				"configure",
				{ cause: error },
			);
		}
	}
	function transaction<T>(operation: (db: DatabaseSync) => T) {
		return use((db) => transact(db, operation));
	}
	return { path, use, transaction };
}

export type OperationDatabase = ReturnType<typeof createOperationDatabase>;
