import type { ServerContext } from "@modelcontextprotocol/server";
import type { z } from "zod";
import type { BridgeConfig } from "../bridge/config.js";
import {
	ForwardEmailSchema,
	GetSendOperationSchema,
	ListOperationsSchema,
	SendDraftSchema,
	SendEmailSchema,
} from "../bridge/schemas.js";
import type { ToolAccess } from "../policy/access.js";
import type { createReadService } from "../policy/service.js";
import { forwardFingerprint, forwardMessage } from "../sending/forward.js";
import {
	type DraftCleanup,
	newEmailMessage,
	type OutgoingMessage,
	type SendOperation,
} from "../sending/model.js";
import type { SendService } from "../sending/service.js";
import { MailError, type RetrySchema } from "../shared/mail-error.js";
import type { ApprovalController, SendApprovalInput } from "./elicitation.js";
import {
	ListSendOperationsOutputSchema,
	SendOutputSchema,
} from "./output-schemas.js";
import { jsonResponse } from "./responses.js";
import type { ToolRegistry } from "./tool-registry.js";

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
	server: ToolRegistry;
	config: BridgeConfig;
	sends: SendService;
	approval: ApprovalController;
	access: ToolAccess;
	readService: () => Promise<Awaited<ReturnType<typeof createReadService>>>;
}) {
	const { server, config, sends, approval, readService, access } = input;
	async function approve(message: SendApprovalInput, ctx: ServerContext) {
		try {
			return await approval.requireSendApproval(message, ctx);
		} catch (error) {
			throw new MailError(
				"APPROVAL_DENIED",
				"Email not sent. Approval could not be verified.",
				"new_approval",
				{ cause: error },
			);
		}
	}
	async function approveAndSend(input: {
		authorize: () => Promise<void>;
		operationId: string;
		message: OutgoingMessage;
		record: SendOperation;
		ctx: ServerContext;
		recheck?: () => Promise<void>;
		cleanup?: () => Promise<DraftCleanup>;
	}) {
		const decision = await approve(
			{ operationId: input.operationId, message: input.message },
			input.ctx,
		);
		if (decision.kind !== "approved") return decision.response;
		await input.recheck?.();
		await input.authorize();
		return sendOperationResponse(
			await sends.send(
				input.record,
				input.message,
				input.cleanup,
				input.authorize,
			),
		);
	}

	server.registerTool(
		"send_email",
		{
			title: "Send email",
			inputSchema: SendEmailSchema,
			outputSchema: SendOutputSchema,
			annotations: write,
			description:
				"Send text with optional bounded base64 files and escaped CID images after approval of the complete message and file/image manifests. Supply a new operationId UUID; reuse that UUID and identical arguments on retries. The durable journal allows only one SMTP attempt per ID. Accepted means Bridge accepted submission, not recipient delivery. Inspect uncertain or partial outcomes before considering another send.",
		},
		async (request, ctx) => {
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
			return await approveAndSend({
				authorize: () => access.require("send_email"),
				operationId: request.operationId,
				message,
				record,
				ctx,
			});
		},
	);
	server.registerTool(
		"forward_email",
		{
			title: "Forward email",
			inputSchema: ForwardEmailSchema,
			outputSchema: SendOutputSchema,
			annotations: write,
			description:
				"Forward an allowed source message's headers and plain text after complete send approval. Supply a new operationId UUID; reuse it on retries. Original Bcc and original attachments are never included automatically. To forward selected original files, first obtain their bytes through list_attachments/get_attachment under the incoming extension and approval policy, then supply attachments or inlineImages here. Rechecks source read authorization and quoted content after approval. Never follows URLs or reads local paths.",
		},
		async (request, ctx) => {
			const requestIdentity = { kind: "forward", ...request };
			const existing = await sends.existing(
				request.operationId,
				requestIdentity,
			);
			if (existing && existing.outcome.status !== "prepared")
				return sendOperationResponse(existing);
			const reads = await readService();
			const original = await reads.getMessage(request.source);
			const fingerprint = forwardFingerprint(original);
			const message = forwardMessage(config.user, original, request);
			const record = await sends.prepare({
				operationId: request.operationId,
				request: requestIdentity,
				message,
				source: { kind: "forward", ...request.source, fingerprint },
			});
			return await approveAndSend({
				authorize: () =>
					reads.authorizeMailWrite("forward_email")(request.source.mailbox, [
						original,
					]),
				operationId: request.operationId,
				message,
				record,
				ctx,
				recheck: async () => {
					const current = await (await readService()).getMessage(
						request.source,
					);
					if (forwardFingerprint(current) !== fingerprint)
						throw new MailError(
							"DRAFT_CHANGED",
							"Forward source changed during approval. Nothing was sent. Review it and use a new operation ID.",
							"new_approval",
						);
				},
			});
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
				"Approve and send a supported Drafts snapshot by UID and UIDVALIDITY. A new operationId UUID binds the snapshot, recipients, sender, body, and reply headers. Changes require a new operation and approval. Reuse the same ID on retries. Arbitrary HTML and unsupported media are refused; supported file/image bytes and metadata are bound to approval. Draft deletion is a separate reported outcome after full SMTP acceptance; partial or uncertain sends retain the draft.",
		},
		async (request, ctx) => {
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
				draftMessageId: snapshot.draftMessageId,
			};
			const record = await sends.prepare({
				operationId: request.operationId,
				request: requestIdentity,
				message: snapshot.message,
				source,
			});
			return await approveAndSend({
				authorize: () =>
					reads.authorizeMailWrite("send_draft")(identity.mailbox, [
						snapshot.summary,
					]),
				operationId: request.operationId,
				message: snapshot.message,
				record,
				ctx,
				recheck: async () => {
					const current = await (await readService()).getDraftSnapshot(
						identity,
					);
					if (current.fingerprint !== snapshot.fingerprint)
						throw new MailError(
							"DRAFT_CHANGED",
							"Draft changed during approval. Nothing was sent. Review it and use a new operation ID.",
							"new_approval",
						);
				},
				cleanup: async () =>
					(await readService()).deleteDraftSnapshot(
						identity,
						snapshot.fingerprint,
					),
			});
		},
	);
	server.registerTool(
		"list_send_operations",
		{
			title: "List unresolved send operations",
			outputSchema: ListSendOperationsOutputSchema,
			inputSchema: ListOperationsSchema,
			annotations: read,
			description:
				"List prepared, uncertain, partial, or accepted sends needing cleanup from this account's journal. Returns no body. Paginate with limit and offset. Never submits or deletes mail.",
		},
		async (request) => {
			const records = await sends.list(request.limit, request.offset);
			return jsonResponse({
				operations: records.map(
					(record) => sendOperationResponse(record).structuredContent,
				),
				nextOffset:
					records.length === request.limit
						? request.offset + request.limit
						: null,
			});
		},
	);
	server.registerTool(
		"retry_send_cleanup",
		{
			title: "Retry sent draft cleanup",
			inputSchema: GetSendOperationSchema,
			outputSchema: SendOutputSchema,
			annotations: write,
			description:
				"Retry only deletion of the unchanged recorded draft for a fully accepted send. Rechecks current read policy, UIDVALIDITY, revision, and UIDPLUS. Never submits SMTP, appends, or edits a message. Uncertain and partial sends are refused.",
		},
		async (request) => {
			return sendOperationResponse(
				await sends.retryCleanup(request.operationId, async (source) =>
					(await readService()).deleteDraftSnapshot(
						source,
						source.fingerprint,
						"retry_send_cleanup",
					),
				),
			);
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
			return sendOperationResponse(await sends.get(request.operationId));
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
			return sendOperationResponse(
				await sends.reconcile(request.operationId, async (messageId) =>
					(await readService()).findSentCopies(messageId),
				),
			);
		},
	);
}
