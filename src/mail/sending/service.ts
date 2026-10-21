import type { BridgeConfig } from "../../bridge/config.js";
import { submitEmail } from "../../bridge/smtp/submission.js";
import { OperationIdSchema } from "../../operations/identity.js";
import {
	createSendStore,
	type SendStore,
} from "../../operations/sqlite/sending.js";
import { hashContent } from "../../shared/content-hash.js";
import { MailError } from "../../shared/mail-error.js";
import { mediaManifest } from "../outgoing/media/model.js";
import type { OutgoingMessage } from "../outgoing/message.js";
import {
	type DraftCleanup,
	type SendOperation,
	type SendSource,
	type SmtpOutcome,
	sendContentHash,
	sendMessageId,
} from "./model.js";

type DraftSource = Extract<SendSource, { kind: "draft" }>;

function errorReason(error: unknown, fallback: string) {
	return error instanceof MailError ? error.message : fallback;
}

async function attemptCleanup(
	cleanup: () => Promise<DraftCleanup>,
): Promise<DraftCleanup> {
	try {
		return await cleanup();
	} catch (error) {
		return {
			status: "failed",
			reason: errorReason(
				error,
				"Draft deletion could not be confirmed. Inspect Drafts; email acceptance is already recorded. Do not resend.",
			),
		};
	}
}

export function createSendService(
	config: BridgeConfig,
	dependencies: {
		store?: SendStore;
		submit?: (
			message: OutgoingMessage,
			messageId: string,
		) => Promise<SmtpOutcome>;
	} = {},
) {
	const store = dependencies.store ?? createSendStore(config.user);
	const submit =
		dependencies.submit ??
		((message, messageId) => submitEmail(config, message, messageId));

	async function get(operationId: string) {
		const record = await store.get(OperationIdSchema.parse(operationId));
		if (!record)
			throw new MailError(
				"NOT_FOUND",
				"Send operation was not found for this account.",
				"never",
			);
		return record;
	}

	async function existing(operationId: string, request: object) {
		const record = await store.get(operationId);
		if (record && record.requestHash !== hashContent(request))
			throw new MailError(
				"OPERATION_CONFLICT",
				"This operation ID belongs to another request. Retrieve its outcome before considering a new send.",
				"never",
			);
		return record;
	}

	async function cleanDraft(
		record: SendOperation,
		cleanup: () => Promise<DraftCleanup>,
	) {
		if (record.draftCleanup.status === "deleted") return record;
		const draftCleanup = await attemptCleanup(cleanup);
		try {
			return await store.updateCleanup(record.operationId, draftCleanup);
		} catch {
			return {
				...record,
				draftCleanup: {
					status: "failed" as const,
					reason:
						"Draft cleanup ran but its result could not be persisted. Inspect Drafts; do not resend.",
				},
			};
		}
	}

	async function retryCleanup(
		operationId: string,
		cleanup: (source: DraftSource) => Promise<DraftCleanup>,
	) {
		const record = await get(operationId);
		if (record.outcome.status !== "accepted" || record.source.kind !== "draft")
			throw new MailError(
				"OPERATION_CONFLICT",
				"Cleanup requires a fully accepted draft send. Uncertain and partial operations retain their drafts.",
				"reconcile",
			);
		const source = record.source;
		return cleanDraft(record, () => cleanup(source));
	}

	async function prepare(input: {
		operationId: string;
		request: object;
		message: OutgoingMessage;
		source: SendSource;
	}) {
		const now = new Date().toISOString();
		return store.prepare({
			operationId: input.operationId,
			messageId: sendMessageId(input.operationId),
			requestHash: hashContent(input.request),
			contentHash: sendContentHash(input.message, input.source),
			source: input.source,
			createdAt: now,
			updatedAt: now,
			outcome: { status: "prepared" },
			sentCopies: [],
			...(input.message.media?.length
				? { media: mediaManifest(input.message.media) }
				: {}),
			draftCleanup:
				input.source.kind === "draft"
					? { status: "pending" }
					: { status: "not_applicable" },
		});
	}

	async function submitOnce(
		message: OutgoingMessage,
		messageId: string,
	): Promise<SmtpOutcome> {
		try {
			return await submit(message, messageId);
		} catch {
			return {
				status: "uncertain",
				reason:
					"SMTP submission was interrupted. Reconcile this operation before considering another send.",
			};
		}
	}

	async function persistOutcome(
		record: SendOperation,
		outcome: SmtpOutcome,
	): Promise<SendOperation> {
		try {
			return await store.finish(record.operationId, outcome);
		} catch {
			return {
				...record,
				outcome: {
					status: "uncertain",
					reason:
						"SMTP finished but its outcome could not be persisted. The durable submission claim prevents another attempt. Restore the journal and reconcile.",
				},
			};
		}
	}

	async function send(
		record: SendOperation,
		message: OutgoingMessage,
		options: {
			cleanup?: () => Promise<DraftCleanup>;
			authorize?: () => Promise<void>;
		} = {},
	) {
		if (sendContentHash(message, record.source) !== record.contentHash)
			throw new MailError(
				"OPERATION_CONFLICT",
				"Send content does not match the approved operation.",
				"new_approval",
			);
		if (!(await store.claim(record.operationId, record.contentHash)))
			return get(record.operationId);

		try {
			await options.authorize?.();
		} catch (error) {
			// The claim stays durable. Record a definite non-submission rather
			// than treating an authorization failure as uncertain SMTP.
			return store.finish(record.operationId, {
				status: "rejected",
				reason: errorReason(
					error,
					"Submission authorization failed. No email was submitted.",
				),
			});
		}

		const outcome = await submitOnce(message, record.messageId);
		// Persist acceptance before attempting the separately reported draft cleanup.
		const saved = await persistOutcome(record, outcome);
		if (saved.outcome.status === "accepted" && saved.source.kind === "draft")
			return cleanDraft(
				saved,
				options.cleanup ?? (async () => ({ status: "not_applicable" })),
			);
		return saved;
	}

	async function reconcile(
		operationId: string,
		find: (messageId: string) => Promise<Parameters<SendStore["reconcile"]>[1]>,
	) {
		const record = await get(operationId);
		if (
			record.outcome.status !== "uncertain" &&
			record.outcome.status !== "submitting"
		)
			return record;
		const matches = await find(record.messageId);
		// No Sent copy is not proof of rejection. Keep uncertainty until positive evidence exists.
		if (!matches.length) return record;
		return store.reconcile(record.operationId, matches);
	}

	return {
		get,
		list: store.list,
		retryCleanup,
		existing,
		prepare,
		send,
		reconcile,
	};
}

export type SendService = ReturnType<typeof createSendService>;
