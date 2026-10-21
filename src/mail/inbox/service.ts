import type { CopyResponseObject, MailboxObject } from "imapflow";
import type { BridgeConfig } from "@/bridge/config.js";
import type { MessageFilter } from "@/bridge/imap/reading/messages.js";
import { messageSummary } from "@/bridge/imap/serializers.js";
import type { ImapClient, ImapSession } from "@/bridge/imap/session.js";
import type { GetMessageInput } from "@/mail/identity.js";
import { OperationIdSchema } from "@/operations/identity.js";
import {
	createInboxStore,
	type InboxStore,
} from "@/operations/sqlite/inbox.js";
import { hashContent } from "@/shared/content-hash.js";
import { safeErrorMessage } from "@/shared/errors.js";
import { MailError } from "@/shared/mail-error.js";
import {
	type InspectedMessage,
	inspectMessage,
	metadataHash,
	reconcileInboxEvidence,
} from "./evidence.js";
import { inboxPlan, mailboxKind } from "./mailboxes.js";
import type { InboxOperation, InboxPlan, ManageMessageInput } from "./model.js";

export type InboxAuthorization = (
	destination: string | undefined,
) => Promise<MessageFilter>;

type FlagPlan = Extract<InboxPlan, { kind: "flag" }>;

type MovePlan = Extract<InboxPlan, { kind: "move" }>;

type AttemptPhase = "unclaimed" | "reserved" | "submitting" | "command_started";

type Attempt = { phase: AttemptPhase };

function planDestination(plan: InboxPlan) {
	return plan.kind === "move" ? plan.destination : undefined;
}

function requireNativeMove(
	client: ImapClient,
	message: string,
	retry: MailError["retry"],
) {
	if (!client.capabilities.has("MOVE"))
		throw new MailError("UNSUPPORTED_CONTENT", message, retry);
}

function requirePermanentFlag(
	selected: MailboxObject,
	flag: FlagPlan["flag"],
	message: string,
) {
	if (!selected.permanentFlags?.has(flag))
		throw new MailError("UNSUPPORTED_CONTENT", message, "configure");
}

function movedIdentity(
	plan: MovePlan,
	moved: CopyResponseObject,
	sourceUid: number,
): GetMessageInput | null {
	const uid = moved.uidMap?.get(sourceUid);
	if (!uid || !moved.uidValidity) return null;
	return {
		mailbox: plan.destination,
		uid,
		uidValidity: moved.uidValidity.toString(),
	};
}

export function createInboxService(
	config: BridgeConfig,
	run: ImapSession,
	store: InboxStore = createInboxStore(config.user),
) {
	async function get(operationId: string) {
		const record = await store.get(OperationIdSchema.parse(operationId));
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

	async function capabilities() {
		return run(async (client) => {
			const mailboxes = await client.list();
			return {
				nativeMoveSupported: client.capabilities.has("MOVE"),
				mailboxes: mailboxes
					.filter((mailbox) => !mailbox.flags.has("\\Noselect"))
					.map((mailbox) => ({
						path: mailbox.path,
						kind: mailboxKind(mailbox, mailboxes),
					})),
			};
		});
	}

	async function preflight(
		client: ImapClient,
		input: ManageMessageInput,
		authorize: InboxAuthorization,
	) {
		const plan = inboxPlan(input, await client.list());
		const accepts = await authorize(planDestination(plan));
		const source = await inspectMessage(client, input, accepts);
		if (!source)
			throw new MailError(
				"NOT_FOUND",
				"Message was not found. Refresh its identity.",
				"refresh_identity",
			);

		if (plan.kind === "move")
			requireNativeMove(
				client,
				"This Bridge connection lacks native MOVE. Copy/delete fallback is refused.",
				"configure",
			);
		if (plan.kind === "flag")
			requirePermanentFlag(
				source.selected,
				plan.flag,
				`Mailbox does not advertise permanent ${plan.flag} support.`,
			);
		return { plan, source };
	}

	function operationRecord(
		input: ManageMessageInput,
		plan: InboxPlan,
		source: InspectedMessage,
	): Omit<InboxOperation, "outcome"> {
		const now = new Date().toISOString();
		return {
			operationId: input.operationId,
			requestHash: hashContent(input),
			request: input,
			plan,
			messageId: source.message.envelope?.messageId ?? null,
			metadataHash: metadataHash(source.message, input.uidValidity),
			createdAt: now,
			updatedAt: now,
		};
	}

	async function recheckReservedSource(
		client: ImapClient,
		record: Omit<InboxOperation, "outcome">,
		authorize: InboxAuthorization,
	) {
		const { request, plan } = record;
		const accepts = await authorize(planDestination(plan));
		const current = await inspectMessage(client, request, accepts);
		if (
			!current ||
			metadataHash(current.message, request.uidValidity) !== record.metadataHash
		)
			throw new MailError(
				"OPERATION_CONFLICT",
				"Source message changed before the inbox write. Inspect it and the operation.",
				"reconcile",
			);
		return { current, accepts };
	}

	function requireCapabilitiesUnchanged(
		client: ImapClient,
		plan: InboxPlan,
		current: InspectedMessage,
	) {
		if (plan.kind === "flag")
			requirePermanentFlag(
				current.selected,
				plan.flag,
				`Permanent ${plan.flag} support changed before execution. Nothing was written.`,
			);
		if (plan.kind === "move")
			requireNativeMove(
				client,
				"Native MOVE support changed before execution. No copy/delete fallback is allowed.",
				"reconcile",
			);
	}

	async function authorizeDispatch(
		client: ImapClient,
		input: ManageMessageInput,
		plan: InboxPlan,
		current: InspectedMessage,
		authorize: InboxAuthorization,
	) {
		const accepts = await authorize(planDestination(plan));
		if (
			!accepts(
				input.mailbox,
				messageSummary(current.message, input.uidValidity),
			)
		)
			throw new MailError(
				"POLICY_DENIED",
				"Current read policy denies this inbox write.",
				"configure",
			);
		// The dispatch transition awaits storage; capabilities can change meanwhile.
		if (plan.kind === "move")
			requireNativeMove(
				client,
				"Native MOVE support changed at dispatch. No copy/delete fallback is allowed.",
				"reconcile",
			);
	}

	async function executeFlagChange(
		client: ImapClient,
		input: ManageMessageInput,
		plan: FlagPlan,
		accepts: MessageFilter,
	) {
		const options = { uid: true };
		const stored = plan.enabled
			? await client.messageFlagsAdd(input.uid, [plan.flag], options)
			: await client.messageFlagsRemove(input.uid, [plan.flag], options);
		if (!stored)
			throw new MailError(
				"OPERATION_FAILED",
				"Flag STORE could not be confirmed. Inspect the recorded operation; do not repeat it under another ID.",
				"reconcile",
			);

		const checked = await inspectMessage(client, input, accepts);
		if (!checked && plan.sourceMayDisappear)
			return store.complete(input.operationId, null);
		if (!checked || checked.message.flags?.has(plan.flag) !== plan.enabled)
			throw new MailError(
				"OPERATION_FAILED",
				"Requested flag state could not be verified.",
				"reconcile",
			);
		return store.complete(input.operationId, null);
	}

	async function executeMove(
		client: ImapClient,
		input: ManageMessageInput,
		plan: MovePlan,
	) {
		const moved = await client.messageMove(input.uid, plan.destination, {
			uid: true,
		});
		if (!moved)
			throw new MailError(
				"OPERATION_FAILED",
				"MOVE could not be confirmed. Inspect the operation and both mailboxes before any new write.",
				"reconcile",
			);
		return store.complete(
			input.operationId,
			movedIdentity(plan, moved, input.uid),
		);
	}

	async function attemptChange(
		client: ImapClient,
		input: ManageMessageInput,
		authorize: InboxAuthorization,
		attempt: Attempt,
	): Promise<InboxOperation> {
		const { plan, source } = await preflight(client, input, authorize);

		const record = operationRecord(input, plan, source);
		if (!(await store.claim(record))) return get(input.operationId);
		attempt.phase = "reserved";

		const { current, accepts } = await recheckReservedSource(
			client,
			record,
			authorize,
		);
		// A desired-state no-op owns a reservation, but never dispatches.
		if (
			plan.kind === "flag" &&
			current.message.flags?.has(plan.flag) === plan.enabled
		)
			return store.complete(input.operationId, null);
		requireCapabilitiesUnchanged(client, plan, current);

		if (!(await store.dispatch(input.operationId)))
			return get(input.operationId);
		attempt.phase = "submitting";
		await authorizeDispatch(client, input, plan, current, authorize);

		attempt.phase = "command_started";
		return plan.kind === "flag"
			? executeFlagChange(client, input, plan, accepts)
			: executeMove(client, input, plan);
	}

	async function settleFailedAttempt(
		input: ManageMessageInput,
		phase: AttemptPhase,
		error: unknown,
	) {
		if (phase === "unclaimed") {
			const replay = await existing(input);
			if (replay) return replay;
			throw error;
		}

		const reason = safeErrorMessage(error);
		// Abort only a state this owner knows has not reached IMAP.
		// A lost dispatch acknowledgement or a started command stays uncertain.
		const expectedStatus = phase === "submitting" ? "submitting" : "reserved";
		const settled = await store.abort(
			input.operationId,
			reason,
			expectedStatus,
		);
		if (settled.outcome.status === "submitting")
			return store.uncertain(input.operationId, reason);
		return settled;
	}

	async function manage(
		input: ManageMessageInput,
		authorize: InboxAuthorization,
	) {
		const previous = await existing(input);
		if (previous) return previous;

		const attempt: Attempt = { phase: "unclaimed" };
		try {
			return await run((client) =>
				attemptChange(client, input, authorize, attempt),
			);
		} catch (error) {
			return settleFailedAttempt(input, attempt.phase, error);
		}
	}

	async function reconcile(operationId: string, authorize: InboxAuthorization) {
		const record = await get(operationId);
		const { status } = record.outcome;
		if (status === "completed" || status === "aborted") return record;
		if (status === "submitting" || status === "reserved")
			throw new MailError(
				"OPERATION_BUSY",
				"This inbox command may still be running or have been interrupted before its outcome was recorded. Its reservation cannot be automatically released. Inspect Bridge and the journal; never replace the operation ID to retry.",
				"never",
			);

		const accepts = await authorize(planDestination(record.plan));
		return run(async (client) => {
			const evidence = await reconcileInboxEvidence(client, record, accepts);
			if (evidence.kind === "completed")
				return store.complete(operationId, evidence.destinationIdentity);
			return get(operationId);
		});
	}

	return {
		get,
		list: store.list,
		capabilities,
		manage,
		reconcile,
	};
}
