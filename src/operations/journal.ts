import { z } from "zod";
import { createOperationDatabase } from "@/operations/sqlite/database.js";
import { createDraftJournal } from "@/operations/sqlite/drafts.js";
import { createInboxJournal } from "@/operations/sqlite/inbox.js";
import { createSendJournal } from "@/operations/sqlite/sending.js";

const IntegrityResultSchema = z.object({ quick_check: z.literal("ok") });

export function createOperationJournal(account: string, directory?: string) {
	const database = createOperationDatabase(account, directory);
	return {
		drafts: createDraftJournal(database),
		sends: createSendJournal(database),
		inbox: createInboxJournal(database),
		checkIntegrity: () =>
			database.use((db) => {
				const results = db.prepare("PRAGMA quick_check").all();
				if (
					results.length !== 1 ||
					!IntegrityResultSchema.safeParse(results[0]).success
				)
					throw new Error(
						"The operation journal failed SQLite integrity checks.",
					);
			}),
	};
}
