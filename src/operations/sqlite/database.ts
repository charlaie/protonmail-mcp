import { chmod, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { getConfigDirectory } from "@/config/paths.js";
import { hashContent } from "@/shared/content-hash.js";
import { MailError } from "@/shared/mail-error.js";

const JOURNAL_VERSION = 1;
const JournalVersionSchema = z.object({ user_version: z.number().int() });

const JOURNAL_SCHEMA = [
	"CREATE TABLE sends (id TEXT PRIMARY KEY, record TEXT NOT NULL);",
	"CREATE TABLE draft_claims (identity TEXT PRIMARY KEY, operation_id TEXT NOT NULL);",
	"CREATE TABLE drafts (id TEXT PRIMARY KEY, message_id TEXT UNIQUE NOT NULL, record TEXT NOT NULL);",
	"CREATE TABLE draft_mutations (identity TEXT PRIMARY KEY, operation_id TEXT NOT NULL);",
	"CREATE TABLE inbox_operations (id TEXT PRIMARY KEY, record TEXT NOT NULL);",
	"CREATE TABLE inbox_claims (identity TEXT PRIMARY KEY, operation_id TEXT NOT NULL);",
	"CREATE TABLE draft_identities (identity TEXT PRIMARY KEY, draft_id TEXT NOT NULL, record TEXT NOT NULL);",
	"CREATE INDEX draft_identities_by_id ON draft_identities (draft_id);",
	"CREATE INDEX drafts_by_logical_id ON drafts (json_extract(record, '$.draftId'));",
].join(" ");

function journalVersion(db: DatabaseSync) {
	return JournalVersionSchema.parse(db.prepare("PRAGMA user_version").get())
		.user_version;
}

function initializeJournal(db: DatabaseSync) {
	if (journalVersion(db) === JOURNAL_VERSION) return;
	transact(db, () => {
		const version = journalVersion(db);
		if (version === JOURNAL_VERSION) return;
		const existingTable = db
			.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' LIMIT 1")
			.get();
		if (version !== 0 || existingTable)
			throw new MailError(
				"STORAGE_FAILED",
				"Unsupported operation journal format. This development build does not migrate older journals. Keep the existing journal for manual recovery; use a separate operationsDirectory for a fresh development account state.",
				"configure",
			);
		db.exec(JOURNAL_SCHEMA);
		db.exec(`PRAGMA user_version=${JOURNAL_VERSION}`);
	});
}

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

async function preparePrivateFile(directory: string, path: string) {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const file = await open(path, "a", 0o600);
	await file.close();
	await chmod(path, 0o600);
}

function storageError(error: unknown) {
	if (error instanceof MailError) return error;
	return new MailError(
		"STORAGE_FAILED",
		"Operation journal could not be accessed. Restore access and inspect the operation ID before retrying any attempted write.",
		"configure",
		{ cause: error },
	);
}

export function createOperationDatabase(
	account: string,
	directory = join(getConfigDirectory(), "send-operations"),
) {
	const path = join(directory, `${hashContent(account)}.sqlite`);

	async function use<T>(operation: (db: DatabaseSync) => T): Promise<T> {
		try {
			await preparePrivateFile(directory, path);
			const db = new DatabaseSync(path);
			try {
				db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
				initializeJournal(db);
				return operation(db);
			} finally {
				db.close();
			}
		} catch (error) {
			throw storageError(error);
		}
	}

	function transaction<T>(operation: (db: DatabaseSync) => T) {
		return use((db) => transact(db, operation));
	}

	return { path, use, transaction };
}

export type OperationDatabase = ReturnType<typeof createOperationDatabase>;
