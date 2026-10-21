import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { z } from "zod";
import { MailError } from "../../shared/mail-error.js";

const RecordRowSchema = z.object({ record: z.string() });
const IdRowSchema = z.object({ id: z.string() });

export function parseRecord<T>(schema: z.ZodType<T>, row: unknown): T {
	return schema.parse(JSON.parse(RecordRowSchema.parse(row).record));
}

export function selectRecord<T>(
	db: DatabaseSync,
	schema: z.ZodType<T>,
	sql: string,
	...parameters: SQLInputValue[]
): T | null {
	const row = db.prepare(sql).get(...parameters);
	return row ? parseRecord(schema, row) : null;
}

export function selectRecords<T>(
	db: DatabaseSync,
	schema: z.ZodType<T>,
	sql: string,
	...parameters: SQLInputValue[]
): T[] {
	return db
		.prepare(sql)
		.all(...parameters)
		.map((row) => parseRecord(schema, row));
}

export function selectId(
	db: DatabaseSync,
	sql: string,
	...parameters: SQLInputValue[]
): string | undefined {
	const row = db.prepare(sql).get(...parameters);
	return row ? IdRowSchema.parse(row).id : undefined;
}

/** Whether a claim repeats a recorded operation; a different request conflicts. */
export function isRecordedReplay(
	existing: { requestHash: string } | null,
	requestHash: string,
	conflictMessage: string,
) {
	if (!existing) return false;
	if (existing.requestHash !== requestHash)
		throw new MailError("OPERATION_CONFLICT", conflictMessage, "never");
	return true;
}

type OperationTable = "drafts" | "sends" | "inbox_operations";

/** Reads and rewrites the JSON operation records stored in one journal table. */
export function operationRecords<T extends { operationId: string }>(
	table: OperationTable,
	schema: z.ZodType<T>,
	notFoundMessage: string,
) {
	function read(db: DatabaseSync, id: string) {
		return selectRecord(
			db,
			schema,
			`SELECT record FROM ${table} WHERE id = ?`,
			id,
		);
	}

	function require(db: DatabaseSync, id: string) {
		const record = read(db, id);
		if (!record) throw new MailError("NOT_FOUND", notFoundMessage, "never");
		return record;
	}

	function save(db: DatabaseSync, record: T) {
		const next = schema.parse({
			...record,
			updatedAt: new Date().toISOString(),
		});
		db.prepare(`UPDATE ${table} SET record = ? WHERE id = ?`).run(
			JSON.stringify(next),
			next.operationId,
		);
		return next;
	}

	return { read, require, save };
}
