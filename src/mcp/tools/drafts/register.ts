import type { BridgeConfig } from "@/bridge/config.js";
import type { ImapService } from "@/bridge/imap/service.js";
import type { MailAccess } from "@/mail/access.js";
import type { DraftOperation } from "@/mail/drafts/model.js";
import {
	CreateDraftSchema,
	CreateReplyDraftSchema,
	EditDraftRequestSchema,
	GetDraftSchema,
} from "@/mail/drafts/requests.js";
import type { DraftWorkflow } from "@/mail/drafts/workflow.js";
import { configuredSenderSchema } from "@/mail/outgoing/senders.js";
import {
	ADDITIVE_WRITE_TOOL,
	DESTRUCTIVE_WRITE_TOOL,
	READ_ONLY_TOOL,
} from "@/mcp/protocol/annotations.js";
import {
	jsonResponse,
	operationPageResponse,
} from "@/mcp/protocol/responses.js";
import type { ToolRegistry } from "@/mcp/protocol/tool-registry.js";
import {
	GetOperationSchema,
	ListOperationsSchema,
} from "@/operations/identity.js";
import {
	DraftOperationOutputSchema,
	GetDraftOutputSchema,
	ListDraftOperationsOutputSchema,
} from "./schemas.js";

function publicDraftRecord(record: DraftOperation) {
	const { requestHash: _requestHash, ...publicRecord } = record;
	const { status } = record.outcome;
	const isFinal = status === "completed" || status === "rejected";
	return { ...publicRecord, retry: isFinal ? "never" : "reconcile" };
}

export function draftOperationResponse(record: DraftOperation) {
	return {
		...jsonResponse(publicDraftRecord(record)),
		isError: record.outcome.status !== "completed",
	};
}

export function registerDraftTools(input: {
	server: ToolRegistry;
	config: BridgeConfig;
	imap: ImapService;
	mailAccess: () => Promise<MailAccess>;
	workflow: DraftWorkflow;
}) {
	const { server, config, imap, mailAccess, workflow } = input;
	const sender = { from: configuredSenderSchema(config).optional() };

	server.registerTool(
		"create_draft",
		{
			title: "Create draft",
			inputSchema: CreateDraftSchema.safeExtend(sender),
			outputSchema: DraftOperationOutputSchema,
			annotations: ADDITIVE_WRITE_TOOL,
			description:
				"Save a text draft with optional bounded base64 attachments and inline images without sending. Supply a new operationId UUID and reuse it with identical arguments on retries. Empty recipients, subject and body are allowed. Durable APPEND intent prevents duplicates after restart; appending means uncertain and requires reconciliation. Requires allowed Drafts mailbox access.",
		},
		async (request) => draftOperationResponse(await workflow.create(request)),
	);

	server.registerTool(
		"create_reply_draft",
		{
			title: "Create reply draft",
			inputSchema: CreateReplyDraftSchema.safeExtend(sender),
			outputSchema: DraftOperationOutputSchema,
			annotations: ADDITIVE_WRITE_TOOL,
			description:
				"Create a plain-text reply or reply-all using allowed source reads, Reply-To, own aliases, and reply headers. Never copies original Bcc or sends mail. Supply an operationId UUID; identical retries return the durable operation without creating another reply. Requires Drafts access.",
		},
		async (request) => draftOperationResponse(await workflow.reply(request)),
	);

	server.registerTool(
		"get_draft",
		{
			title: "Read editable draft",
			inputSchema: GetDraftSchema,
			outputSchema: GetDraftOutputSchema,
			annotations: READ_ONLY_TOOL,
			description:
				"Read a policy-authorized draft by stable draftId or by mailbox, UID and UIDVALIDITY. Returns draftId, current physical identity, Bcc, byte-free file/image manifests and its revision token. Keep revision for edit_draft expectedRevision. Logical IDs survive server-managed edits and restarts with the same account journal; unresolved APPEND blocks ID resolution. Empty unfinished drafts are supported. Arbitrary HTML, unsupported media, oversized drafts, and disallowed senders are refused.",
		},
		async (request) => {
			const mail = await mailAccess();
			return jsonResponse(await mail.getDraft(request));
		},
	);

	server.registerTool(
		"edit_draft",
		{
			title: "Edit draft",
			inputSchema: EditDraftRequestSchema,
			outputSchema: DraftOperationOutputSchema,
			annotations: DESTRUCTIVE_WRITE_TOOL,
			description:
				"Patch a readable supported draft using either draftId or UID and UIDVALIDITY, plus expectedRevision from get_draft. Returns the same stable draftId with the replacement's physical identity. Omitted fields and attachment/inline-image groups are preserved; [] clears the specified recipient or payload group and an empty string clears subject or body. Requires a new operationId UUID, reused with identical arguments on retries. Preserves sender and reply headers. Drafts with an attempted send or unresolved replacement are blocked. Creates one replacement, then safely deletes the unchanged original. Uncertain results require recovery; never change operation IDs to retry.",
		},
		async (request) => {
			const mail = await mailAccess();
			return draftOperationResponse(await mail.editDraft(request));
		},
	);

	server.registerTool(
		"get_draft_operation",
		{
			title: "Get draft operation",
			inputSchema: GetOperationSchema,
			outputSchema: DraftOperationOutputSchema,
			annotations: READ_ONLY_TOOL,
			description:
				"Inspect this account's durable draft operation by UUID, including after restart. Returns recovery identity and status without message body. Does not append, send or delete mail.",
		},
		async ({ operationId }) =>
			draftOperationResponse(await imap.drafts.get(operationId)),
	);

	server.registerTool(
		"list_draft_operations",
		{
			title: "List unresolved draft operations",
			outputSchema: ListDraftOperationsOutputSchema,
			inputSchema: ListOperationsSchema,
			annotations: READ_ONLY_TOOL,
			description:
				"List unresolved draft APPEND and cleanup operations for this account without body content. Paginate with limit and offset. Never modifies mail.",
		},
		async (page) =>
			operationPageResponse(
				await imap.drafts.list(page.limit, page.offset),
				page,
				publicDraftRecord,
			),
	);

	server.registerTool(
		"reconcile_draft_operation",
		{
			title: "Reconcile draft operation",
			inputSchema: GetOperationSchema,
			outputSchema: DraftOperationOutputSchema,
			annotations: ADDITIVE_WRITE_TOOL,
			description:
				"Resolve uncertain APPEND only through one exact operation Message-ID and unchanged canonical content in allowed Drafts. No match keeps uncertainty; conflicting or duplicate copies are refused. Never appends, submits SMTP or deletes mail. Use retry_draft_cleanup separately when an edit's replacement was found.",
		},
		async ({ operationId }) => {
			const mail = await mailAccess();
			return draftOperationResponse(
				await mail.reconcileDraftOperation(operationId),
			);
		},
	);

	server.registerTool(
		"retry_draft_cleanup",
		{
			title: "Retry draft replacement cleanup",
			inputSchema: GetOperationSchema,
			outputSchema: DraftOperationOutputSchema,
			annotations: DESTRUCTIVE_WRITE_TOOL,
			description:
				"Retry only deletion of an edit operation's recorded original. Verifies the replacement still exists unchanged and the original has the recorded revision and UIDVALIDITY. Requires current sender/mailbox read authorization and UIDPLUS. Never appends, sends, or edits contents. Uncertain APPEND must first be reconciled.",
		},
		async ({ operationId }) => {
			const mail = await mailAccess();
			return draftOperationResponse(await mail.retryDraftCleanup(operationId));
		},
	);
}
