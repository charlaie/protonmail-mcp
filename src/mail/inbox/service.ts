import type { FetchMessageObject } from "imapflow";
import type { BridgeConfig } from "../../bridge/config.js";
import { findMessageCopies } from "../../bridge/imap/message-copies.js";
import {
	checkUidValidity,
	type MessageFilter,
	SUMMARY_FIELDS,
} from "../../bridge/imap/reading/messages.js";
import { messageSummary } from "../../bridge/imap/serializers.js";
import type { ImapClient, ImapSession } from "../../bridge/imap/session.js";
import { GetOperationSchema } from "../../operations/identity.js";
import {
	createInboxStore,
	type InboxStore,
} from "../../operations/sqlite/inbox.js";
import { hashContent } from "../../shared/content-hash.js";
import { safeErrorMessage } from "../../shared/errors.js";
import { MailError } from "../../shared/mail-error.js";
import type { GetMessageInput } from "../identity.js";
import { inboxPlan, mailboxKind } from "./mailboxes.js";
import type { InboxOperation, ManageMessageInput } from "./model.js";

export type InboxAuthorization = (
	destination: string | undefined,
) => Promise<MessageFilter>;
function metadataHash(message: FetchMessageObject, uidValidity: string) {
	const summary = messageSummary(message, uidValidity);
	return hashContent({
		messageId: message.envelope?.messageId ?? null,
		subject: summary.subject,
		from: summary.from,
		to: summary.to,
		cc: summary.cc,
		size: summary.size,
	});
}
async function inspectMessage(
	client: ImapClient,
	identity: GetMessageInput,
	accepts: MessageFilter,
) {
	const selected = await client.mailboxOpen(identity.mailbox);
	checkUidValidity(identity.uidValidity, selected.uidValidity);
	const message = await client.fetchOne(identity.uid, SUMMARY_FIELDS, {
		uid: true,
	});
	if (!message) return null;
	if (!accepts(identity.mailbox, messageSummary(message, identity.uidValidity)))
		throw new MailError(
			"POLICY_DENIED",
			"Message sender is not allowed by the read policy.",
			"configure",
		);
	if (
		!message.flags ||
		message.flags.has("\\Draft") ||
		message.flags.has("\\Deleted")
	)
		throw new MailError(
			"POLICY_DENIED",
			"Inbox tools cannot mutate drafts, deleted messages, or messages without known flags.",
			"never",
		);
	return { message, selected };
}
export function createInboxService(
	config: BridgeConfig,
	run: ImapSession,
	store: InboxStore = createInboxStore(config.user),
) {
	async function get(operationId: string) {
		const id = GetOperationSchema.shape.operationId.parse(operationId);
		const record = await store.get(id);
		if (!record)
			throw new MailError(
				"NOT_FOUND",
				"Inbox operation was not found for this account.",
				"never",
			);
		return record;
	}
	async function existing(input: ManageMessageInput) {
		const record = await store.get(input.operationId);
		if (record && record.requestHash !== hashContent(input))
			throw new MailError(
				"OPERATION_CONFLICT",
				"Inbox operation ID belongs to another request. Inspect its outcome.",
				"never",
			);
		return record;
	}
	return {
		get,
		list: store.list,
		capabilities: () =>
			run(async (client) => {
				const mailboxes = await client.list();
				return {
					nativeMoveSupported: client.capabilities.has("MOVE"),
					mailboxes: mailboxes
						.filter((item) => !item.flags.has("\\Noselect"))
						.map((item) => ({
							path: item.path,
							kind: mailboxKind(item, mailboxes),
						})),
				};
			}),
		async manage(input: ManageMessageInput, authorize: InboxAuthorization) {
			const previous = await existing(input);
			if (previous) return previous;
			let claimed = false;
			let dispatchStatus: "reserved" | "submitting" = "reserved";
			let commandStarted = false;
			try {
				return await run(async (client) => {
					const plan = inboxPlan(input, await client.list());
					const destination =
						plan.kind === "move" ? plan.destination : undefined;
					const accepts = await authorize(destination);
					const source = await inspectMessage(client, input, accepts);
					if (!source)
						throw new MailError(
							"NOT_FOUND",
							"Message was not found. Refresh its identity.",
							"refresh_identity",
						);
					if (plan.kind === "move" && !client.capabilities.has("MOVE"))
						throw new MailError(
							"UNSUPPORTED_CONTENT",
							"This Bridge connection lacks native MOVE. Copy/delete fallback is refused.",
							"configure",
						);
					if (
						plan.kind === "flag" &&
						!source.selected.permanentFlags?.has(plan.flag)
					)
						throw new MailError(
							"UNSUPPORTED_CONTENT",
							`Mailbox does not advertise permanent ${plan.flag} support.`,
							"configure",
						);
					const now = new Date().toISOString();
					const record: Omit<InboxOperation, "outcome"> = {
						operationId: input.operationId,
						requestHash: hashContent(input),
						request: input,
						plan,
						messageId: source.message.envelope?.messageId ?? null,
						metadataHash: metadataHash(source.message, input.uidValidity),
						createdAt: now,
						updatedAt: now,
					};
					claimed = await store.claim(record);
					if (!claimed) return get(input.operationId);
					const currentAccepts = await authorize(destination);
					const current = await inspectMessage(client, input, currentAccepts);
					if (
						!current ||
						metadataHash(current.message, input.uidValidity) !==
							record.metadataHash
					)
						throw new MailError(
							"OPERATION_CONFLICT",
							"Source message changed before the inbox write. Inspect it and the operation.",
							"reconcile",
						);
					if (plan.kind === "flag") {
						if (current.message.flags?.has(plan.flag) !== plan.enabled) {
							if (!current.selected.permanentFlags?.has(plan.flag))
								throw new MailError(
									"UNSUPPORTED_CONTENT",
									`Permanent ${plan.flag} support changed before execution. Nothing was written.`,
									"configure",
								);
							if (!(await store.dispatch(input.operationId)))
								return get(input.operationId);
							dispatchStatus = "submitting";
							const dispatchAccepts = await authorize(destination);
							if (
								!dispatchAccepts(
									input.mailbox,
									messageSummary(current.message, input.uidValidity),
								)
							)
								throw new MailError(
									"POLICY_DENIED",
									"Current read policy denies this inbox write.",
									"configure",
								);
							commandStarted = true;
							const ok = plan.enabled
								? await client.messageFlagsAdd(input.uid, [plan.flag], {
										uid: true,
									})
								: await client.messageFlagsRemove(input.uid, [plan.flag], {
										uid: true,
									});
							if (!ok)
								throw new MailError(
									"OPERATION_FAILED",
									"Flag STORE could not be confirmed. Inspect the recorded operation; do not repeat it under another ID.",
									"reconcile",
								);
							const checked = await inspectMessage(
								client,
								input,
								currentAccepts,
							);
							if (!checked && plan.sourceMayDisappear)
								return store.complete(input.operationId, null);
							if (
								!checked ||
								checked.message.flags?.has(plan.flag) !== plan.enabled
							)
								throw new MailError(
									"OPERATION_FAILED",
									"Requested flag state could not be verified.",
									"reconcile",
								);
						}
						return store.complete(input.operationId, null);
					}
					if (!client.capabilities.has("MOVE"))
						throw new MailError(
							"UNSUPPORTED_CONTENT",
							"Native MOVE support changed before execution. No copy/delete fallback is allowed.",
							"reconcile",
						);
					if (!(await store.dispatch(input.operationId)))
						return get(input.operationId);
					dispatchStatus = "submitting";
					const dispatchAccepts = await authorize(destination);
					if (
						!dispatchAccepts(
							input.mailbox,
							messageSummary(current.message, input.uidValidity),
						)
					)
						throw new MailError(
							"POLICY_DENIED",
							"Current read policy denies this inbox write.",
							"configure",
						);
					// The transition may await storage; recheck native MOVE at the actual dispatch boundary.
					if (!client.capabilities.has("MOVE"))
						throw new MailError(
							"UNSUPPORTED_CONTENT",
							"Native MOVE support changed at dispatch. No copy/delete fallback is allowed.",
							"reconcile",
						);
					commandStarted = true;
					const moved = await client.messageMove(input.uid, plan.destination, {
						uid: true,
					});
					if (!moved)
						throw new MailError(
							"OPERATION_FAILED",
							"MOVE could not be confirmed. Inspect the operation and both mailboxes before any new write.",
							"reconcile",
						);
					const uid = moved.uidMap?.get(input.uid);
					return store.complete(
						input.operationId,
						uid && moved.uidValidity
							? {
									mailbox: plan.destination,
									uid,
									uidValidity: moved.uidValidity.toString(),
								}
							: null,
					);
				});
			} catch (error) {
				if (claimed) {
					const reason = safeErrorMessage(error);
					const result = await store.abort(
						input.operationId,
						reason,
						commandStarted ? "reserved" : dispatchStatus,
					);
					return result.outcome.status === "submitting"
						? store.uncertain(input.operationId, reason)
						: result;
				}
				const replay = await existing(input);
				if (replay) return replay;
				throw error;
			}
		},
		async reconcile(operationId: string, authorize: InboxAuthorization) {
			const record = await get(operationId);
			if (
				record.outcome.status === "completed" ||
				record.outcome.status === "aborted"
			)
				return record;
			if (
				record.outcome.status === "submitting" ||
				record.outcome.status === "reserved"
			)
				throw new MailError(
					"OPERATION_BUSY",
					"This inbox command may still be running or have been interrupted before its outcome was recorded. Its reservation cannot be automatically released. Inspect Bridge and the journal; never replace the operation ID to retry.",
					"never",
				);
			const plan = record.plan;
			const accepts = await authorize(
				plan.kind === "move" ? plan.destination : undefined,
			);
			return run(async (client) => {
				const source = await inspectMessage(client, record.request, accepts);
				if (plan.kind === "flag") {
					if (
						source &&
						metadataHash(source.message, record.request.uidValidity) ===
							record.metadataHash &&
						source.message.flags?.has(plan.flag) === plan.enabled
					)
						return store.complete(operationId, null);
					return get(operationId);
				}
				if (!record.messageId) return get(operationId);
				const identities = await findMessageCopies(
					client,
					plan.destination,
					record.messageId,
					accepts,
				);
				if (identities.length !== 1) return get(operationId);
				const targetIdentity = identities[0];
				if (!targetIdentity) return get(operationId);
				const target = await inspectMessage(client, targetIdentity, accepts);
				if (
					!target ||
					metadataHash(target.message, targetIdentity.uidValidity) !==
						record.metadataHash
				)
					return get(operationId);
				if (plan.retainsSource) {
					const copies = await findMessageCopies(
						client,
						record.request.mailbox,
						record.messageId,
						accepts,
					);
					if (copies.length !== 1) return get(operationId);
					const identity = copies[0];
					if (!identity) return get(operationId);
					const retained = await inspectMessage(client, identity, accepts);
					if (
						!retained ||
						metadataHash(retained.message, identity.uidValidity) !==
							record.metadataHash
					)
						return get(operationId);
				} else if (source) return get(operationId);
				return store.complete(operationId, targetIdentity);
			});
		},
	};
}
