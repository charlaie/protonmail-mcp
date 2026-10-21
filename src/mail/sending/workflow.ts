import type { z } from "zod";
import type { BridgeConfig } from "@/bridge/config.js";
import type { MailAccess } from "@/mail/access.js";
import type { OutgoingMessage } from "@/mail/outgoing/message.js";
import { resolveSender } from "@/mail/outgoing/senders.js";
import type { ToolAccess } from "@/policy/access.js";
import { MailError } from "@/shared/mail-error.js";
import { forwardFingerprint, forwardMessage } from "./forward.js";
import {
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

export function createSendWorkflow(input: {
	config: BridgeConfig;
	sends: SendService;
	access: ToolAccess;
	mailAccess: () => Promise<MailAccess>;
}) {
	const { config, sends, access, mailAccess } = input;
	return {
		async email<Response>(
			request: SendEmailInput,
			approve: SendApproval<Response>,
		): Promise<SendWorkflowResult<Response>> {
			const identity = { kind: "email", ...request };
			const existing = await sends.existing(request.operationId, identity);
			if (existing && existing.outcome.status !== "prepared")
				return { kind: "operation", operation: existing };
			const message = newEmailMessage(
				resolveSender(config, request.from),
				request,
			);
			const record = await sends.prepare({
				operationId: request.operationId,
				request: identity,
				message,
				source: { kind: "email" },
			});
			const decision = await approve({
				operationId: request.operationId,
				message,
			});
			if (decision.kind === "response") return decision;
			const authorize = () => access.require("send_email");
			await authorize();
			return {
				kind: "operation",
				operation: await sends.send(record, message, undefined, authorize),
			};
		},
		async forward<Response>(
			request: z.infer<typeof ForwardEmailSchema>,
			approve: SendApproval<Response>,
		): Promise<SendWorkflowResult<Response>> {
			const requestIdentity = { kind: "forward", ...request };
			const existing = await sends.existing(
				request.operationId,
				requestIdentity,
			);
			if (existing && existing.outcome.status !== "prepared")
				return { kind: "operation", operation: existing };
			const reads = await mailAccess();
			const original = await reads.getMessage(request.source);
			const fingerprint = forwardFingerprint(original);
			const message = forwardMessage(
				resolveSender(config, request.from),
				original,
				request,
			);
			const record = await sends.prepare({
				operationId: request.operationId,
				request: requestIdentity,
				message,
				source: { kind: "forward", ...request.source, fingerprint },
			});
			const decision = await approve({
				operationId: request.operationId,
				message,
			});
			if (decision.kind === "response") return decision;
			const current = await (await mailAccess()).getMessage(request.source);
			if (forwardFingerprint(current) !== fingerprint)
				throw new MailError(
					"DRAFT_CHANGED",
					"Forward source changed during approval. Nothing was sent. Review it and use a new operation ID.",
					"new_approval",
				);
			const authorize = () =>
				reads.authorizeMailWrite("forward_email")(request.source.mailbox, [
					original,
				]);
			await authorize();
			return {
				kind: "operation",
				operation: await sends.send(record, message, undefined, authorize),
			};
		},
		async draft<Response>(
			request: z.infer<typeof SendDraftRequestSchema>,
			approve: SendApproval<Response>,
		): Promise<SendWorkflowResult<Response>> {
			const reads = await mailAccess();
			const mailbox = await reads.requireDraftsMailbox();
			const requestIdentity = { kind: "draft", ...request, mailbox };
			const existing = await sends.existing(
				request.operationId,
				requestIdentity,
			);
			if (existing && existing.outcome.status !== "prepared")
				return { kind: "operation", operation: existing };
			const identity = await reads.resolveDraftReference(
				"draftId" in request
					? { draftId: request.draftId }
					: { mailbox, uid: request.uid, uidValidity: request.uidValidity },
				mailbox,
			);
			const snapshot = await reads.getDraftSnapshot(identity);
			const source = {
				kind: "draft",
				...identity,
				fingerprint: snapshot.fingerprint,
				draftMessageId: snapshot.draftMessageId,
			} satisfies SendSource;
			const record = await sends.prepare({
				operationId: request.operationId,
				request: requestIdentity,
				message: snapshot.message,
				source,
			});
			const decision = await approve({
				operationId: request.operationId,
				message: snapshot.message,
			});
			if (decision.kind === "response") return decision;
			const current = await (await mailAccess()).getDraftSnapshot(identity);
			if (current.fingerprint !== snapshot.fingerprint)
				throw new MailError(
					"DRAFT_CHANGED",
					"Draft changed during approval. Nothing was sent. Review it and use a new operation ID.",
					"new_approval",
				);
			const authorize = () =>
				reads.authorizeMailWrite("send_draft")(identity.mailbox, [
					snapshot.summary,
				]);
			await authorize();
			return {
				kind: "operation",
				operation: await sends.send(
					record,
					snapshot.message,
					async () =>
						(await mailAccess()).deleteDraftSnapshot(
							identity,
							snapshot.fingerprint,
						),
					authorize,
				),
			};
		},
		async retryCleanup(operationId: string) {
			return sends.retryCleanup(operationId, async (source) =>
				(await mailAccess()).deleteDraftSnapshot(
					source,
					source.fingerprint,
					"retry_send_cleanup",
				),
			);
		},
		async reconcile(operationId: string) {
			return sends.reconcile(operationId, async (messageId) =>
				(await mailAccess()).findSentCopies(messageId),
			);
		},
	};
}

export type SendWorkflow = ReturnType<typeof createSendWorkflow>;
