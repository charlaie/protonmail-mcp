import type { MailboxObject } from "imapflow";
import type { ParsedMail } from "mailparser";
import type { MailWriteAuthorization } from "../../bridge/authorization.js";
import type { BridgeConfig } from "../../bridge/config.js";
import { findMessageCopies } from "../../bridge/imap/message-copies.js";
import {
	allowAllMessages,
	checkUidValidity,
	type MessageFilter,
} from "../../bridge/imap/reading/messages.js";
import { parsedAddressEmails } from "../../bridge/imap/serializers.js";
import type { ImapClient, ImapSession } from "../../bridge/imap/session.js";
import { OperationIdSchema } from "../../operations/identity.js";
import {
	createDraftStore,
	type DraftStore,
} from "../../operations/sqlite/drafts.js";
import { hashContent } from "../../shared/content-hash.js";
import { safeErrorMessage } from "../../shared/errors.js";
import { MailError } from "../../shared/mail-error.js";
import type { GetMessageInput } from "../identity.js";
import { mediaManifest } from "../outgoing/media/model.js";
import {
	type CreateDraftLookupInput,
	composeDraft,
	type DraftComposition,
	type EditDraftLookupInput,
} from "./composition/compose.js";
import type { DraftOperation } from "./model.js";
import type { EditDraftRequest, GetDraftInput } from "./requests.js";
import {
	draftContentHash,
	type InspectedDraft,
	inspectDraft,
	readDraftSnapshot,
} from "./snapshots.js";

type DraftLookupInput = CreateDraftLookupInput | EditDraftLookupInput;
type DraftRecord = Omit<DraftOperation, "draftId">;
type ComposedDraft = Awaited<ReturnType<typeof composeDraft>>;

type EditSource = Extract<DraftOperation["source"], { kind: "edit" }>;

type SavedRevision = { identity: GetMessageInput; revision: string };

type SnapshotDeletion =
	| { status: "deleted" }
	| { status: "retained"; reason: string };

function isEdit(input: DraftLookupInput): input is EditDraftLookupInput {
	return "uid" in input;
}

function matchesRecordedContent(original: ParsedMail, record: DraftRecord) {
	return (
		original.messageId === record.messageId &&
		draftContentHash(original) === record.contentHash
	);
}

async function inspectDraftIfPresent(
	client: ImapClient,
	identity: GetMessageInput,
	accepts: MessageFilter,
) {
	try {
		return await inspectDraft(client, identity, accepts);
	} catch (error) {
		if (error instanceof MailError && error.code === "NOT_FOUND")
			return undefined;
		throw error;
	}
}

async function inspectEditTarget(
	client: ImapClient,
	input: EditDraftLookupInput,
	accepts: MessageFilter,
): Promise<InspectedDraft> {
	const inspected = await inspectDraft(client, input, accepts);
	if (inspected.fingerprint !== input.expectedRevision)
		throw new MailError(
			"DRAFT_CHANGED",
			"Draft revision changed. Read get_draft again before editing.",
			"refresh_identity",
		);
	if (!client.capabilities.has("UIDPLUS"))
		throw new MailError(
			"OPERATION_FAILED",
			"Draft editing requires UIDPLUS. Edit the draft in Proton Mail.",
			"never",
		);
	return inspected;
}

async function prepareComposition(
	client: ImapClient,
	input: DraftLookupInput,
	accepts: MessageFilter,
): Promise<{ composition: DraftComposition; inspected?: InspectedDraft }> {
	if (!isEdit(input)) return { composition: { kind: "create", input } };
	const inspected = await inspectEditTarget(client, input, accepts);
	return {
		composition: { kind: "edit", input, original: inspected.original },
		inspected,
	};
}

function draftSource(input: DraftLookupInput): DraftOperation["source"] {
	if (!isEdit(input)) return { kind: "create" };
	return {
		kind: "edit",
		mailbox: input.mailbox,
		uid: input.uid,
		uidValidity: input.uidValidity,
		revision: input.expectedRevision,
	};
}

function draftRecord(
	input: DraftLookupInput,
	request: object,
	composed: ComposedDraft,
): DraftRecord {
	const now = new Date().toISOString();
	return {
		operationId: input.operationId,
		requestHash: hashContent(request),
		messageId: composed.messageId,
		contentHash: composed.contentHash,
		...(composed.media.length ? { media: composed.media } : {}),
		mailbox: input.mailbox,
		source: draftSource(input),
		createdAt: now,
		updatedAt: now,
		outcome: { status: "appending" },
	};
}

/**
 * Returns the verified replacement, or undefined when APPEND or its
 * verification is unconfirmed. The library can fail after the server accepted
 * the message, so every such failure leaves the claim for reconciliation.
 */
async function appendAndVerify(
	client: ImapClient,
	selected: MailboxObject,
	record: DraftRecord,
	content: Buffer,
	accepts: MessageFilter,
): Promise<SavedRevision | undefined> {
	try {
		const appended = await client.append(
			record.mailbox,
			content,
			["\\Seen", "\\Draft"],
			new Date(),
		);
		if (!appended || appended.uid === undefined) return undefined;

		const identity = {
			mailbox: record.mailbox,
			uid: appended.uid,
			uidValidity: (appended.uidValidity ?? selected.uidValidity).toString(),
		};
		const persisted = await inspectDraft(client, identity, accepts);
		if (!matchesRecordedContent(persisted.original, record)) return undefined;
		return { identity, revision: persisted.fingerprint };
	} catch {
		return undefined;
	}
}

async function deleteReplacedOriginal(
	client: ImapClient,
	source: EditSource,
	replacement: SavedRevision,
	accepts: MessageFilter,
	authorize: MailWriteAuthorization,
) {
	const target = await inspectDraft(client, replacement.identity, accepts);
	if (target.fingerprint !== replacement.revision)
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

	const current = await inspectDraftIfPresent(client, source, accepts);
	if (!current) return;
	if (current.fingerprint !== source.revision)
		throw new MailError(
			"DRAFT_CHANGED",
			"Original draft changed. Cleanup retained it; inspect both drafts in Proton Mail.",
			"reconcile",
		);

	await authorize(source.mailbox, [target.summary, current.summary]);
	if (!(await client.messageDelete(source.uid, { uid: true })))
		throw new MailError(
			"OPERATION_FAILED",
			"Original draft deletion was not confirmed.",
			"reconcile",
		);
}

async function deleteSnapshotIfUnchanged(
	client: ImapClient,
	input: GetMessageInput,
	fingerprint: string,
	accepts: MessageFilter,
	authorize: MailWriteAuthorization,
): Promise<SnapshotDeletion> {
	const current = await inspectDraftIfPresent(client, input, accepts);
	if (!current) return { status: "deleted" };
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

	await authorize(input.mailbox, [current.summary]);
	if (!(await client.messageDelete(input.uid, { uid: true })))
		throw new MailError(
			"OPERATION_FAILED",
			"Draft deletion was not confirmed.",
			"reconcile",
		);
	return { status: "deleted" };
}

async function findAppendedCopies(
	client: ImapClient,
	record: DraftOperation,
	accepts: MessageFilter,
) {
	const identities = await findMessageCopies(
		client,
		record.mailbox,
		record.messageId,
		accepts,
	);
	const verified: SavedRevision[] = [];
	for (const identity of identities) {
		const draft = await inspectDraft(client, identity, accepts);
		if (!matchesRecordedContent(draft.original, record))
			throw new MailError(
				"OPERATION_CONFLICT",
				"Draft recovery found the operation Message-ID with different content. Inspect Drafts in Proton Mail.",
				"reconcile",
			);
		verified.push({ identity, revision: draft.fingerprint });
	}
	return verified;
}

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
		authorize: MailWriteAuthorization,
	) {
		if (
			record.source.kind !== "edit" ||
			record.outcome.status === "appending" ||
			record.outcome.status === "rejected" ||
			record.outcome.status === "completed"
		)
			return record;

		const source = record.source;
		const replacement = record.outcome;
		try {
			await run((client) =>
				deleteReplacedOriginal(client, source, replacement, accepts, authorize),
			);
		} catch (error) {
			return store.cleanup(record.operationId, {
				status: "cleanup_failed",
				reason: safeErrorMessage(error),
			});
		}
		return store.cleanup(record.operationId, { status: "completed" });
	}

	async function appendClaimedDraft(
		client: ImapClient,
		input: DraftLookupInput,
		request: object,
		accepts: MessageFilter,
		authorize: MailWriteAuthorization,
	) {
		const selected = await client.mailboxOpen(input.mailbox);
		const { composition, inspected } = await prepareComposition(
			client,
			input,
			accepts,
		);
		const composed = await composeDraft(config, composition);

		const record = draftRecord(input, request, composed);
		if (!(await store.claim(record, inspected?.original.messageId)))
			return get(input.operationId);
		// The journal claim precedes the external write. A crash or lost acknowledgment never authorizes another APPEND.
		try {
			await authorize(input.mailbox, inspected ? [inspected.summary] : []);
		} catch (error) {
			// This owner has not invoked APPEND. Keep the UUID terminal while
			// releasing the original message for a newly reviewed operation.
			return store.reject(input.operationId, safeErrorMessage(error));
		}

		const saved = await appendAndVerify(
			client,
			selected,
			record,
			composed.content,
			accepts,
		);
		if (!saved) return get(input.operationId);
		try {
			return await store.saved(
				input.operationId,
				saved.identity,
				saved.revision,
			);
		} catch {
			return get(input.operationId);
		}
	}

	async function write(
		input: DraftLookupInput,
		request: object,
		accepts: MessageFilter,
		authorize: MailWriteAuthorization,
	) {
		const previous = await existing(input.operationId, request);
		if (previous) return previous;

		let record: DraftOperation;
		try {
			record = await run((client) =>
				appendClaimedDraft(client, input, request, accepts, authorize),
			);
		} catch (error) {
			// Another process may complete this same edit while preflight is reading the old UID.
			const replay = await existing(input.operationId, request);
			if (!replay) throw error;
			record = replay;
		}

		if (record.source.kind === "edit" && record.outcome.status === "saved")
			return cleanup(record, accepts, authorize);
		return record;
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

	function read(input: GetMessageInput, accepts: MessageFilter) {
		return run(async (client) => {
			const { original, fingerprint, media } = await inspectDraft(
				client,
				input,
				accepts,
			);
			const draftId = await store.identify(input, {
				messageId: original.messageId,
				contentHash: draftContentHash(original),
			});
			return {
				...input,
				draftId,
				revision: fingerprint,
				from: original.from?.text ?? "",
				to: parsedAddressEmails(original.to),
				cc: parsedAddressEmails(original.cc),
				bcc: parsedAddressEmails(original.bcc),
				subject: original.subject ?? "",
				text: original.text ?? "",
				media: mediaManifest(media),
			};
		});
	}

	async function edit(input: {
		request: EditDraftRequest;
		mailbox: string;
		accepts: MessageFilter;
		authorize: MailWriteAuthorization;
	}) {
		const { request, mailbox, accepts, authorize } = input;
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
	}

	async function reconcile(operationId: string, accepts: MessageFilter) {
		const record = await get(operationId);
		if (record.outcome.status !== "appending") return record;

		const copies = await run((client) =>
			findAppendedCopies(client, record, accepts),
		);
		if (copies.length > 1)
			throw new MailError(
				"OPERATION_CONFLICT",
				"Draft recovery found multiple exact copies. No draft was deleted. Inspect Drafts in Proton Mail.",
				"reconcile",
			);
		const [copy] = copies;
		if (!copy) return record;
		return store.saved(operationId, copy.identity, copy.revision);
	}

	return {
		resolveReference,
		read,
		snapshot: (input: GetMessageInput, accepts: MessageFilter) =>
			run((client) => readDraftSnapshot(client, config, input, accepts)),
		deleteSnapshot: (
			input: GetMessageInput,
			fingerprint: string,
			accepts: MessageFilter,
			authorize: MailWriteAuthorization,
		): Promise<SnapshotDeletion> =>
			run((client) =>
				deleteSnapshotIfUnchanged(
					client,
					input,
					fingerprint,
					accepts,
					authorize,
				),
			),
		get,
		existing,
		list: store.list,
		create: (
			input: CreateDraftLookupInput,
			options: { request?: object; authorize: MailWriteAuthorization },
		) =>
			write(
				input,
				options.request ?? input,
				allowAllMessages,
				options.authorize,
			),
		edit,
		reconcile,
		retryCleanup: async (
			operationId: string,
			accepts: MessageFilter,
			authorize: MailWriteAuthorization,
		) => cleanup(await get(operationId), accepts, authorize),
	};
}
