import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import type { z } from "zod";
import type { BridgeConfig } from "../bridge/config.js";
import { withDraftMutation } from "../bridge/draft-lock.js";
import {
	GetSendOperationSchema,
	SendDraftSchema,
	SendEmailSchema,
} from "../bridge/schemas.js";
import type { createReadService } from "../policy/service.js";
import { newEmailMessage, type SendOperation } from "../sending/model.js";
import type { SendService } from "../sending/service.js";
import { MailError, type RetrySchema } from "../shared/mail-error.js";
import type {
	SendApprovalController,
	SendApprovalInput,
} from "./elicitation.js";
import { SendOutputSchema } from "./output-schemas.js";
import { errorResponse, jsonResponse } from "./responses.js";

const write = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: true,
	openWorldHint: true,
};
const read = { ...write, readOnlyHint: true, destructiveHint: false };

export function sendOperationResponse(record: SendOperation) {
	const { requestHash: _requestHash, ...publicRecord } = record;
	const outcome =
		record.outcome.status === "submitting"
			? {
					status: "uncertain" as const,
					reason:
						"Submission started, but its final outcome is not recorded. It may still be running or have been interrupted. Reconcile this operation; do not resend.",
				}
			: record.outcome;
	let retry: z.infer<typeof RetrySchema>;
	switch (outcome.status) {
		case "prepared":
		case "rejected":
			retry = "new_approval";
			break;
		case "partially_accepted":
		case "uncertain":
			retry = "reconcile";
			break;
		case "accepted":
			retry = "never";
			break;
		default: {
			const exhaustive: never = outcome;
			return exhaustive;
		}
	}
	if (outcome.status === "uncertain" && record.sentCopies.length)
		retry = "never";
	return {
		...jsonResponse({ ...publicRecord, outcome, retry }),
		isError:
			["partially_accepted", "rejected", "uncertain"].includes(
				outcome.status,
			) || record.draftCleanup.status === "failed",
	};
}

export function registerSendTools(input: {
	server: McpServer;
	config: BridgeConfig;
	sends: SendService;
	approval: SendApprovalController;
	readService: () => Promise<Awaited<ReturnType<typeof createReadService>>>;
}) {
	const { server, config, sends, approval, readService } = input;
	async function approve(message: SendApprovalInput, ctx: ServerContext) {
		try {
			return await approval.requireApproval(message, ctx);
		} catch (error) {
			throw new MailError(
				"APPROVAL_DENIED",
				"Email not sent. Approval could not be verified.",
				"new_approval",
				{ cause: error },
			);
		}
	}
	server.registerTool(
		"send_email",
		{
			title: "Send email",
			inputSchema: SendEmailSchema,
			outputSchema: SendOutputSchema,
			annotations: write,
			description:
				"Send plain-text email after approval of the complete message. Supply a new operationId UUID; reuse that UUID and identical arguments on retries. The durable journal allows only one SMTP attempt per ID. Accepted means Bridge accepted submission, not recipient delivery. Inspect uncertain or partial outcomes before considering another send.",
		},
		async (request, ctx) => {
			try {
				const identity = { kind: "email", ...request };
				const existing = await sends.existing(request.operationId, identity);
				if (existing && existing.outcome.status !== "prepared")
					return sendOperationResponse(existing);
				const message = newEmailMessage(config.user, request);
				const record = await sends.prepare({
					operationId: request.operationId,
					request: identity,
					message,
					source: { kind: "email" },
				});
				const decision = await approve(
					{ operationId: request.operationId, message },
					ctx,
				);
				if (decision.kind !== "approved") return decision.response;
				return sendOperationResponse(await sends.send(record, message));
			} catch (error) {
				return errorResponse(error);
			}
		},
	);
	server.registerTool(
		"send_draft",
		{
			title: "Send draft",
			inputSchema: SendDraftSchema,
			outputSchema: SendOutputSchema,
			annotations: write,
			description:
				"Approve and send a plain-text Drafts snapshot by UID and UIDVALIDITY. A new operationId UUID binds the snapshot, recipients, sender, body, and reply headers. Changes require a new operation and approval. Reuse the same ID on retries. HTML and attachments are refused. Draft deletion is a separate reported outcome after full SMTP acceptance; partial or uncertain sends retain the draft.",
		},
		async (request, ctx) => {
			try {
				const reads = await readService();
				const identity = {
					mailbox: await reads.requireDraftsMailbox(),
					uid: request.uid,
					uidValidity: request.uidValidity,
				};
				const requestIdentity = {
					kind: "draft",
					...request,
					mailbox: identity.mailbox,
				};
				return await withDraftMutation(config, identity, async () => {
					const existing = await sends.existing(
						request.operationId,
						requestIdentity,
					);
					if (existing && existing.outcome.status !== "prepared")
						return sendOperationResponse(existing);
					const snapshot = await reads.getDraftSnapshot(identity);
					const source = {
						kind: "draft" as const,
						...identity,
						fingerprint: snapshot.fingerprint,
					};
					const record = await sends.prepare({
						operationId: request.operationId,
						request: requestIdentity,
						message: snapshot.message,
						source,
					});
					const decision = await approve(
						{ operationId: request.operationId, message: snapshot.message },
						ctx,
					);
					if (decision.kind !== "approved") return decision.response;
					// Reauthorize and refetch after approval, including legacy clients that await a dialog in this call.
					const currentReads = await readService();
					const current = await currentReads.getDraftSnapshot(identity);
					if (current.fingerprint !== snapshot.fingerprint)
						throw new MailError(
							"DRAFT_CHANGED",
							"Draft changed during approval. Nothing was sent. Review it and use a new operation ID.",
							"new_approval",
						);
					return sendOperationResponse(
						await sends.send(record, snapshot.message, async () =>
							(await readService()).deleteDraftSnapshot(
								identity,
								snapshot.fingerprint,
							),
						),
					);
				});
			} catch (error) {
				return errorResponse(error);
			}
		},
	);
	server.registerTool(
		"get_send_operation",
		{
			title: "Get send operation",
			inputSchema: GetSendOperationSchema,
			outputSchema: SendOutputSchema,
			annotations: read,
			description:
				"Inspect this account's durable send journal by operationId, including after a server restart. Never submits mail or changes draft content. An interrupted submission is reported as uncertain and cannot be retried automatically.",
		},
		async (request) => {
			try {
				return sendOperationResponse(await sends.get(request.operationId));
			} catch (error) {
				return errorResponse(error);
			}
		},
	);
	server.registerTool(
		"reconcile_send_operation",
		{
			title: "Reconcile send operation",
			inputSchema: GetSendOperationSchema,
			outputSchema: SendOutputSchema,
			annotations: { ...write, destructiveHint: false },
			description:
				"Search the allowed Sent mailbox for an uncertain send's exact preassigned Message-ID and record positive evidence. Respects mailbox and sender policy. A Sent copy is evidence of submission, not proof of delivery to every recipient. No match leaves the operation uncertain. Never resends or deletes drafts.",
		},
		async (request) => {
			try {
				return sendOperationResponse(
					await sends.reconcile(request.operationId, async (messageId) =>
						(await readService()).findSentCopies(messageId),
					),
				);
			} catch (error) {
				return errorResponse(error);
			}
		},
	);
}
