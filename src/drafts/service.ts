import type { MailWriteAuthorization } from "../bridge/authorization.js";
import type { BridgeConfig } from "../bridge/config.js";
import { draftContentHash, inspectDraft } from "../bridge/draft-content.js";
import {
	appendDraft,
	type CreateDraftLookupInput,
	composeDraft,
	type EditDraftLookupInput,
} from "../bridge/drafts.js";
import { findMessageCopies } from "../bridge/message-copies.js";
import { checkUidValidity, type MessageFilter } from "../bridge/messages.js";
import { SendEmailSchema } from "../bridge/schemas.js";
import type { ImapSession } from "../bridge/session.js";
import { hashContent } from "../sending/model.js";
import { safeErrorMessage } from "../shared/errors.js";
import { MailError } from "../shared/mail-error.js";
import type { DraftOperation } from "./model.js";
import { createDraftStore, type DraftStore } from "./store.js";

export function createDraftService(
	config: BridgeConfig,
	run: ImapSession,
	store: DraftStore = createDraftStore(config.user),
) {
	async function existing(operationId: string, request: object) {
		const record = await store.get(
			SendEmailSchema.shape.operationId.parse(operationId),
		);
		if (record && record.requestHash !== hashContent(request))
			throw new MailError(
				"OPERATION_CONFLICT",
				"Draft operation ID belongs to another request. Inspect its saved outcome.",
				"never",
			);
		return record;
	}
	async function get(operationId: string) {
		const record = await store.get(
			SendEmailSchema.shape.operationId.parse(operationId),
		);
		if (!record)
			throw new MailError(
				"NOT_FOUND",
				"Draft operation was not found for this account.",
				"never",
			);
		return record;
	}
	async function cleanup(
		record: DraftOperation,
		accepts: MessageFilter,
		authorize?: MailWriteAuthorization,
	) {
		if (
			record.source.kind !== "edit" ||
			record.outcome.status === "appending" ||
			record.outcome.status === "rejected" ||
			record.outcome.status === "completed"
		)
			return record;
		const source = record.source;
		const replacement = record.outcome.identity;
		const replacementRevision = record.outcome.revision;
		try {
			await run(async (client) => {
				const target = await inspectDraft(client, replacement, accepts);
				if (target.fingerprint !== replacementRevision)
					throw new MailError(
						"DRAFT_CHANGED",
						"Replacement draft changed. Original was retained.",
						"reconcile",
					);
				const selected = await client.mailboxOpen(source.mailbox);
				checkUidValidity(source.uidValidity, selected.uidValidity);
				if (!client.capabilities.has("UIDPLUS"))
					throw new MailError(
						"OPERATION_FAILED",
						"UIDPLUS is required for cleanup. Delete the original in Proton Mail.",
						"reconcile",
					);
				let current: Awaited<ReturnType<typeof inspectDraft>>;
				try {
					current = await inspectDraft(client, source, accepts);
				} catch (error) {
					if (error instanceof MailError && error.code === "NOT_FOUND") return;
					throw error;
				}
				if (current.fingerprint !== source.revision)
					throw new MailError(
						"DRAFT_CHANGED",
						"Original draft changed. Cleanup retained it; inspect both drafts in Proton Mail.",
						"reconcile",
					);
				await authorize?.(source.mailbox, [target.summary, current.summary]);
				if (!(await client.messageDelete(source.uid, { uid: true })))
					throw new MailError(
						"OPERATION_FAILED",
						"Original draft deletion was not confirmed.",
						"reconcile",
					);
			});
			return store.cleanup(record.operationId, { status: "completed" });
		} catch (error) {
			return store.cleanup(record.operationId, {
				status: "cleanup_failed",
				reason: safeErrorMessage(error),
			});
		}
	}
	async function write(
		input: CreateDraftLookupInput | EditDraftLookupInput,
		request: object,
		accepts: MessageFilter,
		authorize?: MailWriteAuthorization,
	) {
		const previous = await existing(input.operationId, request);
		if (previous) return previous;
		return run(async (client) => {
			const selected = await client.mailboxOpen(input.mailbox);
			const inspected =
				"uid" in input ? await inspectDraft(client, input, accepts) : undefined;
			if ("uid" in input && inspected?.fingerprint !== input.expectedRevision)
				throw new MailError(
					"DRAFT_CHANGED",
					"Draft revision changed. Read get_draft again before editing.",
					"refresh_identity",
				);
			if ("uid" in input && !client.capabilities.has("UIDPLUS"))
				throw new MailError(
					"OPERATION_FAILED",
					"Draft editing requires UIDPLUS. Edit the draft in Proton Mail.",
					"never",
				);
			const composed = await composeDraft(config, input, inspected?.original);
			const now = new Date().toISOString();
			const record: DraftOperation = {
				operationId: input.operationId,
				requestHash: hashContent(request),
				messageId: composed.messageId,
				contentHash: composed.contentHash,
				...(composed.media.length ? { media: composed.media } : {}),
				mailbox: input.mailbox,
				source:
					"uid" in input
						? {
								kind: "edit",
								mailbox: input.mailbox,
								uid: input.uid,
								uidValidity: input.uidValidity,
								revision: input.expectedRevision,
							}
						: { kind: "create" },
				createdAt: now,
				updatedAt: now,
				outcome: { status: "appending" },
			};
			if (!(await store.claim(record, inspected?.original.messageId)))
				return get(input.operationId);
			// The journal claim precedes the external write. A crash or lost acknowledgment never authorizes another APPEND.
			try {
				await authorize?.(input.mailbox, inspected ? [inspected.summary] : []);
			} catch (error) {
				// This owner has not invoked APPEND. Keep the UUID terminal while
				// releasing the original message for a newly reviewed operation.
				return store.reject(input.operationId, safeErrorMessage(error));
			}
			try {
				const appended = await appendDraft(
					client,
					input.mailbox,
					composed.content,
				);
				if (!appended || appended.uid === undefined)
					return get(input.operationId);
				const identity = {
					mailbox: input.mailbox,
					uid: appended.uid,
					uidValidity: (
						appended.uidValidity ?? selected.uidValidity
					).toString(),
				};
				const persisted = await inspectDraft(client, identity, accepts);
				if (
					persisted.original.messageId !== record.messageId ||
					draftContentHash(persisted.original) !== record.contentHash
				)
					return get(input.operationId);
				const saved = await store.saved(
					input.operationId,
					identity,
					persisted.fingerprint,
				);
				return saved;
			} catch {
				return get(input.operationId);
			}
		})
			.catch(async (error) => {
				// Another process may complete this same edit while preflight is reading the old UID.
				const replay = await existing(input.operationId, request);
				if (replay) return replay;
				throw error;
			})
			.then((record) =>
				record.source.kind === "edit" && record.outcome.status === "saved"
					? cleanup(record, accepts, authorize)
					: record,
			);
	}
	return {
		get,
		existing,
		list: store.list,
		create: (
			input: CreateDraftLookupInput,
			accepts: MessageFilter,
			request: object = input,
			authorize?: MailWriteAuthorization,
		) => write(input, request, accepts, authorize),
		edit: (
			input: EditDraftLookupInput,
			accepts: MessageFilter,
			authorize?: MailWriteAuthorization,
		) => write(input, input, accepts, authorize),
		async reconcile(operationId: string, accepts: MessageFilter) {
			let record = await get(operationId);
			if (record.outcome.status !== "appending") return record;
			const matches = await run(async (client) => {
				const identities = await findMessageCopies(
					client,
					record.mailbox,
					record.messageId,
					accepts,
				);
				const verified = [];
				for (const identity of identities) {
					const draft = await inspectDraft(client, identity, accepts);
					if (
						draft.original.messageId !== record.messageId ||
						draftContentHash(draft.original) !== record.contentHash
					)
						throw new MailError(
							"OPERATION_CONFLICT",
							"Draft recovery found the operation Message-ID with different content. Inspect Drafts in Proton Mail.",
							"reconcile",
						);
					verified.push({ identity, revision: draft.fingerprint });
				}
				return verified;
			});
			if (matches.length > 1)
				throw new MailError(
					"OPERATION_CONFLICT",
					"Draft recovery found multiple exact copies. No draft was deleted. Inspect Drafts in Proton Mail.",
					"reconcile",
				);
			const identity = matches[0];
			if (identity)
				record = await store.saved(
					operationId,
					identity.identity,
					identity.revision,
				);
			return record;
		},
		async retryCleanup(
			operationId: string,
			accepts: MessageFilter,
			authorize?: MailWriteAuthorization,
		) {
			return cleanup(await get(operationId), accepts, authorize);
		},
	};
}
