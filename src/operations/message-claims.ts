import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { GetMessageInput } from "../bridge/schemas.js";
import { DraftOperationSchema } from "../drafts/model.js";
import { hashContent, SendOperationSchema } from "../sending/model.js";
import { MailError } from "../shared/mail-error.js";

const RowSchema = z.object({ record: z.string() });
const OwnerSchema = z.object({ operation_id: z.string() });
export function messageIdentityKey(identity: GetMessageInput) {
	return hashContent({
		mailbox: identity.mailbox,
		uidValidity: identity.uidValidity,
		uid: identity.uid,
	});
}
function conflict(operationId: string) {
	throw new MailError(
		"OPERATION_CONFLICT",
		`Message identity is reserved by operation ${operationId}. Inspect that operation; do not change operation IDs to retry an uncertain write.`,
		"reconcile",
	);
}
// Send, draft edit and inbox claims call this inside BEGIN IMMEDIATE.
export function assertMessageMutable(
	db: DatabaseSync,
	identity: GetMessageInput,
	messageId?: string,
) {
	const key = messageIdentityKey(identity);
	const inbox = db
		.prepare("SELECT operation_id FROM inbox_claims WHERE identity = ?")
		.get(key);
	if (inbox) conflict(OwnerSchema.parse(inbox).operation_id);
	const mutation = db
		.prepare("SELECT operation_id FROM draft_mutations WHERE identity = ?")
		.get(key);
	if (mutation) conflict(OwnerSchema.parse(mutation).operation_id);
	const send = db
		.prepare("SELECT operation_id FROM draft_claims WHERE identity = ?")
		.get(key);
	if (send) {
		const id = OwnerSchema.parse(send).operation_id;
		const row = db.prepare("SELECT record FROM sends WHERE id = ?").get(id);
		if (!row) conflict(id);
		const record = SendOperationSchema.parse(
			JSON.parse(RowSchema.parse(row).record),
		);
		if (record.outcome.status !== "rejected" || record.sentCopies.length)
			conflict(id);
	}
	const target = db
		.prepare(
			"SELECT record FROM drafts WHERE json_extract(record, '$.outcome.status') != 'completed' AND json_extract(record, '$.outcome.identity.mailbox') = ? AND json_extract(record, '$.outcome.identity.uidValidity') = ? AND json_extract(record, '$.outcome.identity.uid') = ?",
		)
		.get(identity.mailbox, identity.uidValidity, identity.uid);
	if (target)
		conflict(
			DraftOperationSchema.parse(JSON.parse(RowSchema.parse(target).record))
				.operationId,
		);
	if (messageId) {
		const inboxProjection = db
			.prepare(
				"SELECT id FROM inbox_operations WHERE json_extract(record, '$.messageId') = ? AND json_extract(record, '$.outcome.status') IN ('reserved', 'submitting', 'uncertain')",
			)
			.get(messageId);
		if (inboxProjection)
			conflict(z.object({ id: z.string() }).parse(inboxProjection).id);
		const attemptedDraft = db
			.prepare(
				"SELECT id FROM sends WHERE json_extract(record, '$.source.kind') = 'draft' AND json_extract(record, '$.source.draftMessageId') = ? AND json_extract(record, '$.outcome.status') != 'prepared' AND (json_extract(record, '$.outcome.status') != 'rejected' OR json_array_length(json_extract(record, '$.sentCopies')) > 0)",
			)
			.get(messageId);
		if (attemptedDraft)
			conflict(z.object({ id: z.string() }).parse(attemptedDraft).id);
		const row = db
			.prepare("SELECT record FROM drafts WHERE message_id = ?")
			.get(messageId);
		if (row) {
			const record = DraftOperationSchema.parse(
				JSON.parse(RowSchema.parse(row).record),
			);
			if (
				record.outcome.status !== "completed" &&
				record.outcome.status !== "rejected"
			)
				conflict(record.operationId);
		}
	}
	return key;
}
