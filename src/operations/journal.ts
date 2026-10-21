import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { createOperationDatabase } from "./sqlite/database.js";
import { createDraftJournal } from "./sqlite/drafts.js";
import { createInboxJournal } from "./sqlite/inbox.js";
import { createSendJournal } from "./sqlite/sending.js";

const IntegrityResultSchema = z.object({ quick_check: z.literal("ok") });

function checkIntegrity(db: DatabaseSync) {
	const results = db.prepare("PRAGMA quick_check").all();
	const passed =
		results.length === 1 && IntegrityResultSchema.safeParse(results[0]).success;
	if (!passed)
		throw new Error("The operation journal failed SQLite integrity checks.");
}

export function createOperationJournal(account: string, directory?: string) {
	const database = createOperationDatabase(account, directory);
	return {
		drafts: createDraftJournal(database),
		sends: createSendJournal(database),
		inbox: createInboxJournal(database),
		checkIntegrity: () => database.use(checkIntegrity),
	};
}
