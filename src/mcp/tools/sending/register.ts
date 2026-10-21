import type { ServerContext } from "@modelcontextprotocol/server";
import type { z } from "zod";
import type { BridgeConfig } from "../../../bridge/config.js";
import { configuredSenderSchema } from "../../../mail/outgoing/senders.js";
import type { SendOperation } from "../../../mail/sending/model.js";
import {
	ForwardEmailSchema,
	SendDraftRequestSchema,
	SendEmailSchema,
} from "../../../mail/sending/requests.js";
import type { SendService } from "../../../mail/sending/service.js";
import type {
	SendApproval,
	SendWorkflow,
	SendWorkflowResult,
} from "../../../mail/sending/workflow.js";
import {
	GetOperationSchema,
	ListOperationsSchema,
} from "../../../operations/identity.js";
import { MailError, type RetrySchema } from "../../../shared/mail-error.js";
import {
	ADDITIVE_WRITE_TOOL,
	DESTRUCTIVE_WRITE_TOOL,
	READ_ONLY_TOOL,
} from "../../protocol/annotations.js";
import type { ApprovalController } from "../../protocol/elicitation.js";
import {
	jsonResponse,
	operationPageResponse,
} from "../../protocol/responses.js";
import type { ToolRegistry } from "../../protocol/tool-registry.js";
import { ListSendOperationsOutputSchema, SendOutputSchema } from "./schemas.js";

type ApprovalResponse = Exclude<
	Awaited<ReturnType<ApprovalController["requireSendApproval"]>>,
	{ kind: "approved" }
>["response"];

type PublicSendOutcome = Exclude<
	SendOperation["outcome"],
	{ status: "submitting" }
>;

const INTERRUPTED_SUBMISSION: PublicSendOutcome = {
	status: "uncertain",
	reason:
		"Submission started, but its final outcome is not recorded. It may still be running or have been interrupted. Reconcile this operation; do not resend.",
};

const FAILED_OUTCOMES: ReadonlySet<PublicSendOutcome["status"]> = new Set([
	"partially_accepted",
	"rejected",
	"uncertain",
]);

function publicOutcome(record: SendOperation): PublicSendOutcome {
	if (record.outcome.status === "submitting") return INTERRUPTED_SUBMISSION;
	return record.outcome;
}

function retryFor(
	outcome: PublicSendOutcome,
	record: SendOperation,
): z.infer<typeof RetrySchema> {
	switch (outcome.status) {
		case "prepared":
		case "rejected":
			return "new_approval";
		case "partially_accepted":
			return "reconcile";
		case "uncertain":
			return record.sentCopies.length ? "never" : "reconcile";
		case "accepted":
			return "never";
		default: {
			const exhaustive: never = outcome;
			return exhaustive;
		}
	}
}

function publicSendRecord(record: SendOperation) {
	const { requestHash: _requestHash, ...publicRecord } = record;
	const outcome = publicOutcome(record);
	return { ...publicRecord, outcome, retry: retryFor(outcome, record) };
}

export function sendOperationResponse(record: SendOperation) {
	const publicRecord = publicSendRecord(record);
	const isError =
		FAILED_OUTCOMES.has(publicRecord.outcome.status) ||
		record.draftCleanup.status === "failed";
	return { ...jsonResponse(publicRecord), isError };
}

function sendWorkflowResponse(result: SendWorkflowResult<ApprovalResponse>) {
	if (result.kind === "operation")
		return sendOperationResponse(result.operation);
	return result.response;
}

function requestApprovalFrom(
	approval: ApprovalController,
	ctx: ServerContext,
): SendApproval<ApprovalResponse> {
	return async (input) => {
		try {
			const decision = await approval.requireSendApproval(input, ctx);
			if (decision.kind === "approved") return decision;
			return { kind: "response", response: decision.response };
		} catch (error) {
			throw new MailError(
				"APPROVAL_DENIED",
				"Email not sent. Approval could not be verified.",
				"new_approval",
				{ cause: error },
			);
		}
	};
}

export function registerSendTools(input: {
	server: ToolRegistry;
	config: BridgeConfig;
	sends: SendService;
	approval: ApprovalController;
	workflow: SendWorkflow;
}) {
	const { server, config, sends, approval, workflow } = input;
	const sender = { from: configuredSenderSchema(config).optional() };

	server.registerTool(
		"send_email",
		{
			title: "Send email",
			inputSchema: SendEmailSchema.safeExtend(sender),
			outputSchema: SendOutputSchema,
			annotations: DESTRUCTIVE_WRITE_TOOL,
			description:
				"Send text with optional bounded base64 files and escaped CID images after approval of the complete message and file/image manifests. Supply a new operationId UUID; reuse that UUID and identical arguments on retries. The durable journal allows only one SMTP attempt per ID. Accepted means Bridge accepted submission, not recipient delivery. Inspect uncertain or partial outcomes before considering another send.",
		},
		async (request, ctx) =>
			sendWorkflowResponse(
				await workflow.email(request, requestApprovalFrom(approval, ctx)),
			),
	);

	server.registerTool(
		"forward_email",
		{
			title: "Forward email",
			inputSchema: ForwardEmailSchema.safeExtend(sender),
			outputSchema: SendOutputSchema,
			annotations: DESTRUCTIVE_WRITE_TOOL,
			description:
				"Forward an allowed source message's headers and plain text after complete send approval. Supply a new operationId UUID; reuse it on retries. Original Bcc and original attachments are never included automatically. To forward selected original files, first obtain their bytes through list_attachments/get_attachment under the incoming extension and approval policy, then supply attachments or inlineImages here. Rechecks source read authorization and quoted content after approval. Never follows URLs or reads local paths.",
		},
		async (request, ctx) =>
			sendWorkflowResponse(
				await workflow.forward(request, requestApprovalFrom(approval, ctx)),
			),
	);

	server.registerTool(
		"send_draft",
		{
			title: "Send draft",
			inputSchema: SendDraftRequestSchema,
			outputSchema: SendOutputSchema,
			annotations: DESTRUCTIVE_WRITE_TOOL,
			description:
				"Approve and send a supported Drafts snapshot by stable draftId or by UID and UIDVALIDITY. The logical ID is resolved once; approval and rechecks bind that exact physical snapshot. A new operationId UUID binds the snapshot, recipients, sender, body, and reply headers. Changes require a new operation and approval. Reuse the same operation ID and arguments on retries. Arbitrary HTML and unsupported media are refused; supported file/image bytes and metadata are bound to approval. Draft deletion is a separate reported outcome after full SMTP acceptance; partial or uncertain sends retain the draft.",
		},
		async (request, ctx) =>
			sendWorkflowResponse(
				await workflow.draft(request, requestApprovalFrom(approval, ctx)),
			),
	);

	server.registerTool(
		"list_send_operations",
		{
			title: "List unresolved send operations",
			outputSchema: ListSendOperationsOutputSchema,
			inputSchema: ListOperationsSchema,
			annotations: READ_ONLY_TOOL,
			description:
				"List prepared, uncertain, partial, or accepted sends needing cleanup from this account's journal. Returns no body. Paginate with limit and offset. Never submits or deletes mail.",
		},
		async (page) =>
			operationPageResponse(
				await sends.list(page.limit, page.offset),
				page,
				publicSendRecord,
			),
	);

	server.registerTool(
		"retry_send_cleanup",
		{
			title: "Retry sent draft cleanup",
			inputSchema: GetOperationSchema,
			outputSchema: SendOutputSchema,
			annotations: DESTRUCTIVE_WRITE_TOOL,
			description:
				"Retry only deletion of the unchanged recorded draft for a fully accepted send. Rechecks current read policy, UIDVALIDITY, revision, and UIDPLUS. Never submits SMTP, appends, or edits a message. Uncertain and partial sends are refused.",
		},
		async ({ operationId }) =>
			sendOperationResponse(await workflow.retryCleanup(operationId)),
	);

	server.registerTool(
		"get_send_operation",
		{
			title: "Get send operation",
			inputSchema: GetOperationSchema,
			outputSchema: SendOutputSchema,
			annotations: READ_ONLY_TOOL,
			description:
				"Inspect this account's durable send journal by operationId, including after a server restart. Never submits mail or changes draft content. An interrupted submission is reported as uncertain and cannot be retried automatically.",
		},
		async ({ operationId }) =>
			sendOperationResponse(await sends.get(operationId)),
	);

	server.registerTool(
		"reconcile_send_operation",
		{
			title: "Reconcile send operation",
			inputSchema: GetOperationSchema,
			outputSchema: SendOutputSchema,
			annotations: ADDITIVE_WRITE_TOOL,
			description:
				"Search the allowed Sent mailbox for an uncertain send's exact preassigned Message-ID and record positive evidence. Respects mailbox and sender policy. A Sent copy is evidence of submission, not proof of delivery to every recipient. No match leaves the operation uncertain. Never resends or deletes drafts.",
		},
		async ({ operationId }) =>
			sendOperationResponse(await workflow.reconcile(operationId)),
	);
}
