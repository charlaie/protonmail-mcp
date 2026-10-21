import type { z } from "zod";
import type { BridgeConfig } from "../../bridge/config.js";
import type { ToolAccess } from "../../policy/access.js";
import { MailError } from "../../shared/mail-error.js";
import type { MailAccess } from "../access.js";
import type { OutgoingMessage } from "../outgoing/message.js";
import { resolveSender } from "../outgoing/senders.js";
import { forwardFingerprint, forwardMessage } from "./forward.js";
import {
	type DraftCleanup,
	newEmailMessage,
	type SendOperation,
	type SendSource,
} from "./model.js";
import type {
	ForwardEmailSchema,
	SendDraftRequestSchema,
	SendEmailInput,
} from "./requests.js";
import type { SendService } from "./service.js";

export type SendApprovalInput = {
	operationId: string;
	message: OutgoingMessage;
};

export type SendApproval<Response> = (
	input: SendApprovalInput,
) => Promise<{ kind: "approved" } | { kind: "response"; response: Response }>;

export type SendWorkflowResult<Response> =
	| { kind: "operation"; operation: SendOperation }
	| { kind: "response"; response: Response };

type SendPlan = {
	message: OutgoingMessage;
	authorize: () => Promise<void>;
} & (
	| { source: Extract<SendSource, { kind: "email" }> }
	| {
			source: Extract<SendSource, { kind: "forward" }>;
			recheck: () => Promise<void>;
	  }
	| {
			source: Extract<SendSource, { kind: "draft" }>;
			recheck: () => Promise<void>;
			cleanup: () => Promise<DraftCleanup>;
	  }
);

export function createSendWorkflow(input: {
	config: BridgeConfig;
	sends: SendService;
	access: ToolAccess;
	mailAccess: () => Promise<MailAccess>;
}) {
	const { config, sends, access, mailAccess } = input;

	// Replay precedes source reads: an accepted send must remain inspectable after
	// its draft is deleted. Approval precedes rechecks and the durable send claim.
	async function execute<Response, Request extends { operationId: string }>(
		request: Request,
		compose: () => Promise<SendPlan>,
		approve: SendApproval<Response>,
	): Promise<SendWorkflowResult<Response>> {
		const existing = await sends.existing(request.operationId, request);
		if (existing && existing.outcome.status !== "prepared")
			return { kind: "operation", operation: existing };

		const plan = await compose();
		const record = await sends.prepare({
			operationId: request.operationId,
			request,
			message: plan.message,
			source: plan.source,
		});
		const decision = await approve({
			operationId: request.operationId,
			message: plan.message,
		});
		if (decision.kind === "response") return decision;

		if ("recheck" in plan) await plan.recheck();
		await plan.authorize();
		return {
			kind: "operation",
			operation: await sends.send(record, plan.message, {
				cleanup: "cleanup" in plan ? plan.cleanup : undefined,
				authorize: plan.authorize,
			}),
		};
	}

	async function composeForward(
		request: z.infer<typeof ForwardEmailSchema>,
	): Promise<SendPlan> {
		const mail = await mailAccess();
		const original = await mail.getMessage(request.source);
		const fingerprint = forwardFingerprint(original);

		async function recheck() {
			const current = await (await mailAccess()).getMessage(request.source);
			if (forwardFingerprint(current) !== fingerprint)
				throw new MailError(
					"DRAFT_CHANGED",
					"Forward source changed during approval. Nothing was sent. Review it and use a new operation ID.",
					"new_approval",
				);
		}

		return {
			message: forwardMessage(
				resolveSender(config, request.from),
				original,
				request,
			),
			source: { kind: "forward", ...request.source, fingerprint },
			recheck,
			authorize: () =>
				mail.authorizeMailWrite("forward_email")(request.source.mailbox, [
					original,
				]),
		};
	}

	async function composeDraftSend(
		mail: MailAccess,
		request: z.infer<typeof SendDraftRequestSchema>,
		mailbox: string,
	): Promise<SendPlan> {
		const identity = await mail.resolveDraftReference(
			"draftId" in request
				? { draftId: request.draftId }
				: { mailbox, uid: request.uid, uidValidity: request.uidValidity },
			mailbox,
		);
		const snapshot = await mail.getDraftSnapshot(identity);

		async function recheck() {
			const current = await (await mailAccess()).getDraftSnapshot(identity);
			if (current.fingerprint !== snapshot.fingerprint)
				throw new MailError(
					"DRAFT_CHANGED",
					"Draft changed during approval. Nothing was sent. Review it and use a new operation ID.",
					"new_approval",
				);
		}

		return {
			message: snapshot.message,
			source: {
				kind: "draft",
				...identity,
				fingerprint: snapshot.fingerprint,
				draftMessageId: snapshot.draftMessageId,
			},
			recheck,
			authorize: () =>
				mail.authorizeMailWrite("send_draft")(identity.mailbox, [
					snapshot.summary,
				]),
			cleanup: async () =>
				(await mailAccess()).deleteDraftSnapshot(
					identity,
					snapshot.fingerprint,
				),
		};
	}

	function email<Response>(
		request: SendEmailInput,
		approve: SendApproval<Response>,
	) {
		return execute(
			{ kind: "email", ...request },
			async () => ({
				message: newEmailMessage(resolveSender(config, request.from), request),
				source: { kind: "email" },
				authorize: () => access.require("send_email"),
			}),
			approve,
		);
	}

	function forward<Response>(
		request: z.infer<typeof ForwardEmailSchema>,
		approve: SendApproval<Response>,
	) {
		return execute(
			{ kind: "forward", ...request },
			() => composeForward(request),
			approve,
		);
	}

	async function draft<Response>(
		request: z.infer<typeof SendDraftRequestSchema>,
		approve: SendApproval<Response>,
	) {
		const mail = await mailAccess();
		const mailbox = await mail.requireDraftsMailbox();
		return execute(
			{ kind: "draft", ...request, mailbox },
			() => composeDraftSend(mail, request, mailbox),
			approve,
		);
	}

	function retryCleanup(operationId: string) {
		return sends.retryCleanup(operationId, async (source) =>
			(await mailAccess()).deleteDraftSnapshot(
				source,
				source.fingerprint,
				"retry_send_cleanup",
			),
		);
	}

	function reconcile(operationId: string) {
		return sends.reconcile(operationId, async (messageId) =>
			(await mailAccess()).findSentCopies(messageId),
		);
	}

	return { email, forward, draft, retryCleanup, reconcile };
}

export type SendWorkflow = ReturnType<typeof createSendWorkflow>;
