import type { MailWriteAuthorization } from "@/bridge/authorization.js";
import type { BridgeConfig } from "@/bridge/config.js";
import { findMessageCopies } from "@/bridge/imap/message-copies.js";
import {
	allowAllMessages,
	checkUidValidity,
	type MessageFilter,
} from "@/bridge/imap/reading/messages.js";
import { parsedAddressEmails } from "@/bridge/imap/serializers.js";
import type { ImapSession } from "@/bridge/imap/session.js";
import {
	appendDraft,
	type CreateDraftLookupInput,
	composeDraft,
	type EditDraftLookupInput,
} from "@/mail/drafts/composition/compose.js";
import type { GetMessageInput } from "@/mail/identity.js";
import { mediaManifest } from "@/mail/outgoing/media/model.js";
import { OperationIdSchema } from "@/operations/identity.js";
import {
	createDraftStore,
	type DraftStore,
} from "@/operations/sqlite/drafts.js";
import { hashContent } from "@/shared/content-hash.js";
import { safeErrorMessage } from "@/shared/errors.js";
import { MailError } from "@/shared/mail-error.js";
import type { DraftOperation } from "./model.js";
import type { EditDraftRequest, GetDraftInput } from "./requests.js";
import {
	draftContentHash,
	inspectDraft,
	readDraftSnapshot,
} from "./snapshots.js";

export function createDraftService(
	config: BridgeConfig,
	run: ImapSession,
	store: DraftStore = createDraftStore(config.user),
) {
	async function existing(operationId: string, request: object) {
		const record = await store.get(OperationIdSchema.parse(operationId));
		if (record && record.requestHash !== hashContent(request))
			throw new MailError(
				"OPERATION_CONFLICT",
				"Draft operation ID belongs to another request. Inspect its saved outcome.",
				"never",
			);
		return record;
	}
	async function get(operationId: string) {
		const record = await store.get(OperationIdSchema.parse(operationId));
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
			const record: Omit<DraftOperation, "draftId"> = {
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
	async function resolveReference(
		input: GetDraftInput,
		draftsMailbox?: string,
	) {
		const identity =
			"draftId" in input ? await store.resolve(input.draftId) : input;
		if (draftsMailbox !== undefined && identity.mailbox !== draftsMailbox)
			throw new MailError(
				"POLICY_DENIED",
				"Logical draft is outside the configured Drafts mailbox.",
				"configure",
			);
		return identity;
	}
	return {
		resolveReference,
		read: (input: GetMessageInput, accepts: MessageFilter = allowAllMessages) =>
			run(async (client) => {
				const { original, fingerprint, media } = await inspectDraft(
					client,
					input,
					accepts,
				);
				return {
					...input,
					draftId: await store.identify(input, {
						messageId: original.messageId,
						contentHash: draftContentHash(original),
					}),
					revision: fingerprint,
					from: original.from?.text ?? "",
					to: parsedAddressEmails(original.to),
					cc: parsedAddressEmails(original.cc),
					bcc: parsedAddressEmails(original.bcc),
					subject: original.subject ?? "",
					text: original.text ?? "",
					media: mediaManifest(media),
				};
			}),
		snapshot: (input: GetMessageInput, accepts: MessageFilter) =>
			run((client) => readDraftSnapshot(client, config, input, accepts)),
		deleteSnapshot: (
			input: GetMessageInput,
			fingerprint: string,
			accepts: MessageFilter,
			authorize?: MailWriteAuthorization,
		): Promise<
			{ status: "deleted" } | { status: "retained"; reason: string }
		> =>
			run(async (client) => {
				let current: Awaited<ReturnType<typeof inspectDraft>>;
				try {
					current = await inspectDraft(client, input, accepts);
				} catch (error) {
					if (error instanceof MailError && error.code === "NOT_FOUND")
						return { status: "deleted" };
					throw error;
				}
				if (current.fingerprint !== fingerprint)
					return {
						status: "retained",
						reason:
							"Draft changed after approval. It was retained; email acceptance is already recorded. Do not resend.",
					};
				if (!client.capabilities.has("UIDPLUS"))
					return {
						status: "retained",
						reason:
							"UIDPLUS is unavailable. Delete the sent draft in Proton Mail; do not resend.",
					};
				await authorize?.(input.mailbox, [current.summary]);
				if (!(await client.messageDelete(input.uid, { uid: true })))
					throw new MailError(
						"OPERATION_FAILED",
						"Draft deletion was not confirmed.",
						"reconcile",
					);
				return { status: "deleted" };
			}),
		get,
		existing,
		list: store.list,
		create: (
			input: CreateDraftLookupInput,
			request: object = input,
			authorize?: MailWriteAuthorization,
		) => write(input, request, allowAllMessages, authorize),
		async edit(input: {
			request: EditDraftRequest;
			mailbox: string;
			accepts?: MessageFilter;
			authorize?: MailWriteAuthorization;
		}) {
			const { request, mailbox, accepts = allowAllMessages, authorize } = input;
			// Replay the original public request before resolving an ID that may now be pending or replaced.
			const durableRequest = { ...request, mailbox };
			const previous = await existing(request.operationId, durableRequest);
			if (previous) return previous;
			const identity = await resolveReference(
				"draftId" in request
					? { draftId: request.draftId }
					: { mailbox, uid: request.uid, uidValidity: request.uidValidity },
				mailbox,
			);
			return write(
				{ ...request, ...identity },
				durableRequest,
				accepts,
				authorize,
			);
		},
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
