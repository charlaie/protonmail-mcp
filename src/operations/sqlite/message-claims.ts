import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { StoredDraftOperationSchema } from "../../mail/drafts/model.js";
import type { GetMessageInput } from "../../mail/identity.js";
import { SendOperationSchema } from "../../mail/sending/model.js";
import { hashContent } from "../../shared/content-hash.js";
import { MailError } from "../../shared/mail-error.js";
import { selectId, selectRecord } from "./records.js";

type ClaimTable = "inbox_claims" | "draft_mutations" | "draft_claims";

const OwnerSchema = z.object({ operation_id: z.string() });

export function messageIdentityKey(identity: GetMessageInput) {
	return hashContent({
		mailbox: identity.mailbox,
		uidValidity: identity.uidValidity,
		uid: identity.uid,
	});
}

function conflict(operationId: string): never {
	throw new MailError(
		"OPERATION_CONFLICT",
		`Message identity is reserved by operation ${operationId}. Inspect that operation; do not change operation IDs to retry an uncertain write.`,
		"reconcile",
	);
}

function claimOwner(db: DatabaseSync, table: ClaimTable, key: string) {
	const row = db
		.prepare(`SELECT operation_id FROM ${table} WHERE identity = ?`)
		.get(key);
	return row ? OwnerSchema.parse(row).operation_id : undefined;
}

// A rejected send that produced no sent copies no longer holds its draft.
function sendHoldsDraft(db: DatabaseSync, operationId: string) {
	const send = selectRecord(
		db,
		SendOperationSchema,
		"SELECT record FROM sends WHERE id = ?",
		operationId,
	);
	if (!send) return true;
	return send.outcome.status !== "rejected" || send.sentCopies.length > 0;
}

function assertIdentityUnclaimed(
	db: DatabaseSync,
	identity: GetMessageInput,
	key: string,
) {
	const inboxOwner = claimOwner(db, "inbox_claims", key);
	if (inboxOwner !== undefined) conflict(inboxOwner);

	const draftEditOwner = claimOwner(db, "draft_mutations", key);
	if (draftEditOwner !== undefined) conflict(draftEditOwner);

	const sendOwner = claimOwner(db, "draft_claims", key);
	if (sendOwner !== undefined && sendHoldsDraft(db, sendOwner))
		conflict(sendOwner);

	const unfinishedDraft = selectRecord(
		db,
		StoredDraftOperationSchema,
		"SELECT record FROM drafts WHERE json_extract(record, '$.outcome.status') != 'completed' AND json_extract(record, '$.outcome.identity.mailbox') = ? AND json_extract(record, '$.outcome.identity.uidValidity') = ? AND json_extract(record, '$.outcome.identity.uid') = ?",
		identity.mailbox,
		identity.uidValidity,
		identity.uid,
	);
	if (unfinishedDraft) conflict(unfinishedDraft.operationId);
}

function assertMessageIdUnclaimed(db: DatabaseSync, messageId: string) {
	const inboxOwner = selectId(
		db,
		"SELECT id FROM inbox_operations WHERE json_extract(record, '$.messageId') = ? AND json_extract(record, '$.outcome.status') IN ('reserved', 'submitting', 'uncertain')",
		messageId,
	);
	if (inboxOwner !== undefined) conflict(inboxOwner);

	const attemptedSend = selectId(
		db,
		"SELECT id FROM sends WHERE json_extract(record, '$.source.kind') = 'draft' AND json_extract(record, '$.source.draftMessageId') = ? AND json_extract(record, '$.outcome.status') != 'prepared' AND (json_extract(record, '$.outcome.status') != 'rejected' OR json_array_length(json_extract(record, '$.sentCopies')) > 0)",
		messageId,
	);
	if (attemptedSend !== undefined) conflict(attemptedSend);

	const draft = selectRecord(
		db,
		StoredDraftOperationSchema,
		"SELECT record FROM drafts WHERE message_id = ?",
		messageId,
	);
	if (
		draft &&
		draft.outcome.status !== "completed" &&
		draft.outcome.status !== "rejected"
	)
		conflict(draft.operationId);
}

// Send, draft edit and inbox claims call this inside BEGIN IMMEDIATE.
export function assertMessageMutable(
	db: DatabaseSync,
	identity: GetMessageInput,
	messageId?: string,
) {
	const key = messageIdentityKey(identity);
	assertIdentityUnclaimed(db, identity, key);
	if (messageId) assertMessageIdUnclaimed(db, messageId);
	return key;
}
