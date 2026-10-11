import type { BridgeConfig } from "../bridge/config.js";
import { SendEmailSchema } from "../bridge/schemas.js";
import { submitEmail } from "../bridge/smtp.js";
import { MailError } from "../shared/mail-error.js";
import {
	type DraftCleanup,
	hashContent,
	type OutgoingMessage,
	type SendOperation,
	type SendSource,
	type SmtpOutcome,
	sendContentHash,
	sendMessageId,
} from "./model.js";
import { createSendStore, type SendStore } from "./store.js";

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
		const record = await store.get(
			SendEmailSchema.shape.operationId.parse(operationId),
		);
		if (!record)
			throw new MailError(
				"NOT_FOUND",
				"Send operation was not found for this account.",
				"never",
			);
		return record;
	}
	return {
		get,
		async existing(operationId: string, request: object) {
			const record = await store.get(operationId);
			if (record && record.requestHash !== hashContent(request))
				throw new MailError(
					"OPERATION_CONFLICT",
					"This operation ID belongs to another request. Retrieve its outcome before considering a new send.",
					"never",
				);
			return record;
		},
		async prepare(input: {
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
				draftCleanup:
					input.source.kind === "draft"
						? { status: "pending" }
						: { status: "not_applicable" },
			});
		},
		async send(
			record: SendOperation,
			message: OutgoingMessage,
			cleanup: () => Promise<DraftCleanup> = async () => ({
				status: "not_applicable",
			}),
		) {
			if (sendContentHash(message, record.source) !== record.contentHash)
				throw new MailError(
					"OPERATION_CONFLICT",
					"Send content does not match the approved operation.",
					"new_approval",
				);
			if (!(await store.claim(record.operationId, record.contentHash)))
				return get(record.operationId);
			let outcome: SmtpOutcome;
			try {
				outcome = await submit(message, record.messageId);
			} catch {
				outcome = {
					status: "uncertain",
					reason:
						"SMTP submission was interrupted. Reconcile this operation before considering another send.",
				};
			}
			// Persist acceptance before attempting the separately reported draft cleanup.
			let saved: SendOperation;
			try {
				saved = await store.finish(record.operationId, outcome);
			} catch {
				return {
					...record,
					outcome: {
						status: "uncertain" as const,
						reason:
							"SMTP finished but its outcome could not be persisted. The durable submission claim prevents another attempt. Restore the journal and reconcile.",
					},
				};
			}
			if (
				saved.outcome.status === "accepted" &&
				saved.source.kind === "draft"
			) {
				let draftCleanup: DraftCleanup;
				try {
					draftCleanup = await cleanup();
				} catch {
					draftCleanup = {
						status: "failed",
						reason:
							"Draft deletion could not be confirmed. Inspect Drafts; email acceptance is already recorded. Do not resend.",
					};
				}
				try {
					return await store.updateCleanup(record.operationId, draftCleanup);
				} catch {
					return {
						...saved,
						draftCleanup: {
							status: "failed" as const,
							reason:
								"Draft cleanup ran but its result could not be persisted. Inspect Drafts; do not resend.",
						},
					};
				}
			}
			return saved;
		},
		async reconcile(
			operationId: string,
			find: (
				messageId: string,
			) => Promise<Parameters<SendStore["reconcile"]>[1]>,
		) {
			const record = await get(operationId);
			if (
				record.outcome.status !== "uncertain" &&
				record.outcome.status !== "submitting"
			)
				return record;
			const matches = await find(record.messageId);
			// No Sent copy is not proof of rejection. Keep uncertainty until positive evidence exists.
			return matches.length
				? await store.reconcile(record.operationId, matches)
				: record;
		},
	};
}
export type SendService = ReturnType<typeof createSendService>;
