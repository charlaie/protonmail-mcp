import type { BridgeConfig } from "@/bridge/config.js";
import type { ImapService } from "@/bridge/imap/service.js";
import type { MailAccess } from "@/mail/access.js";
import { composeReplyDraft } from "@/mail/drafts/composition/replies.js";
import type { DraftOperation } from "@/mail/drafts/model.js";
import {
	CreateDraftSchema,
	CreateReplyDraftSchema,
	EditDraftRequestSchema,
	GetDraftSchema,
} from "@/mail/drafts/requests.js";
import { configuredSenderSchema } from "@/mail/outgoing/senders.js";
import { jsonResponse } from "@/mcp/protocol/responses.js";
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

const write = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: true,
};
const read = { ...write, readOnlyHint: true };
export function draftOperationResponse(record: DraftOperation) {
	const { requestHash: _requestHash, ...publicRecord } = record;
	return {
		...jsonResponse({
			...publicRecord,
			retry: ["completed", "rejected"].includes(record.outcome.status)
				? "never"
				: "reconcile",
		}),
		isError: record.outcome.status !== "completed",
	};
}
export function registerDraftTools(input: {
	server: ToolRegistry;
	config: BridgeConfig;
	imap: ImapService;
	mailAccess: () => Promise<MailAccess>;
}) {
	const { server, config, imap, mailAccess } = input;
	server.registerTool(
		"create_draft",
		{
			title: "Create draft",
			inputSchema: CreateDraftSchema.safeExtend({
				from: configuredSenderSchema(config).optional(),
			}),
			outputSchema: DraftOperationOutputSchema,
			annotations: write,
			description:
				"Save a text draft with optional bounded base64 attachments and inline images without sending. Supply a new operationId UUID and reuse it with identical arguments on retries. Empty recipients, subject and body are allowed. Durable APPEND intent prevents duplicates after restart; appending means uncertain and requires reconciliation. Requires allowed Drafts mailbox access.",
		},
		async (request) => {
			const reads = await mailAccess();
			const mailbox = await reads.requireDraftsMailbox();
			return draftOperationResponse(
				await imap.drafts.create(
					{ ...request, mailbox },
					undefined,
					reads.authorizeMailWrite("create_draft"),
				),
			);
		},
	);
	server.registerTool(
		"create_reply_draft",
		{
			title: "Create reply draft",
			inputSchema: CreateReplyDraftSchema.safeExtend({
				from: configuredSenderSchema(config).optional(),
			}),
			outputSchema: DraftOperationOutputSchema,
			annotations: write,
			description:
				"Create a plain-text reply or reply-all using allowed source reads, Reply-To, own aliases, and reply headers. Never copies original Bcc or sends mail. Supply an operationId UUID; identical retries return the durable operation without creating another reply. Requires Drafts access.",
		},
		async (request) => {
			const reads = await mailAccess();
			const mailbox = await reads.requireDraftsMailbox();
			const previous = await imap.drafts.existing(request.operationId, request);
			if (previous) return draftOperationResponse(previous);
			const original = await reads.getMessage(request);
			return draftOperationResponse(
				await imap.drafts.create(
					composeReplyDraft(config, original, request, mailbox),
					request,
					reads.authorizeMailWrite("create_reply_draft", [
						{ mailbox: request.mailbox, message: original },
					]),
				),
			);
		},
	);
	server.registerTool(
		"get_draft",
		{
			title: "Read editable draft",
			inputSchema: GetDraftSchema,
			outputSchema: GetDraftOutputSchema,
			annotations: read,
			description:
				"Read a policy-authorized draft by stable draftId or by mailbox, UID and UIDVALIDITY. Returns draftId, current physical identity, Bcc, byte-free file/image manifests and its revision token. Keep revision for edit_draft expectedRevision. Logical IDs survive server-managed edits and restarts with the same account journal; unresolved APPEND blocks ID resolution. Empty unfinished drafts are supported. Arbitrary HTML, unsupported media, oversized drafts, and disallowed senders are refused.",
		},
		async (request) => {
			return jsonResponse(await (await mailAccess()).getDraft(request));
		},
	);
	server.registerTool(
		"edit_draft",
		{
			title: "Edit draft",
			inputSchema: EditDraftRequestSchema,
			outputSchema: DraftOperationOutputSchema,
			annotations: { ...write, destructiveHint: true },
			description:
				"Patch a readable supported draft using either draftId or UID and UIDVALIDITY, plus expectedRevision from get_draft. Returns the same stable draftId with the replacement's physical identity. Omitted fields and attachment/inline-image groups are preserved; [] clears the specified recipient or payload group and an empty string clears subject or body. Requires a new operationId UUID, reused with identical arguments on retries. Preserves sender and reply headers. Drafts with an attempted send or unresolved replacement are blocked. Creates one replacement, then safely deletes the unchanged original. Uncertain results require recovery; never change operation IDs to retry.",
		},
		async (request) => {
			return draftOperationResponse(
				await (await mailAccess()).editDraft(request),
			);
		},
	);
	server.registerTool(
		"get_draft_operation",
		{
			title: "Get draft operation",
			inputSchema: GetOperationSchema,
			outputSchema: DraftOperationOutputSchema,
			annotations: read,
			description:
				"Inspect this account's durable draft operation by UUID, including after restart. Returns recovery identity and status without message body. Does not append, send or delete mail.",
		},
		async (request) => {
			return draftOperationResponse(await imap.drafts.get(request.operationId));
		},
	);
	server.registerTool(
		"list_draft_operations",
		{
			title: "List unresolved draft operations",
			outputSchema: ListDraftOperationsOutputSchema,
			inputSchema: ListOperationsSchema,
			annotations: read,
			description:
				"List unresolved draft APPEND and cleanup operations for this account without body content. Paginate with limit and offset. Never modifies mail.",
		},
		async (request) => {
			const records = await imap.drafts.list(request.limit, request.offset);
			return jsonResponse({
				operations: records.map(
					(record) => draftOperationResponse(record).structuredContent,
				),
				nextOffset:
					records.length === request.limit
						? request.offset + request.limit
						: null,
			});
		},
	);
	server.registerTool(
		"reconcile_draft_operation",
		{
			title: "Reconcile draft operation",
			inputSchema: GetOperationSchema,
			outputSchema: DraftOperationOutputSchema,
			annotations: write,
			description:
				"Resolve uncertain APPEND only through one exact operation Message-ID and unchanged canonical content in allowed Drafts. No match keeps uncertainty; conflicting or duplicate copies are refused. Never appends, submits SMTP or deletes mail. Use retry_draft_cleanup separately when an edit's replacement was found.",
		},
		async (request) => {
			return draftOperationResponse(
				await (await mailAccess()).reconcileDraftOperation(request.operationId),
			);
		},
	);
	server.registerTool(
		"retry_draft_cleanup",
		{
			title: "Retry draft replacement cleanup",
			inputSchema: GetOperationSchema,
			outputSchema: DraftOperationOutputSchema,
			annotations: { ...write, destructiveHint: true },
			description:
				"Retry only deletion of an edit operation's recorded original. Verifies the replacement still exists unchanged and the original has the recorded revision and UIDVALIDITY. Requires current sender/mailbox read authorization and UIDPLUS. Never appends, sends, or edits contents. Uncertain APPEND must first be reconciled.",
		},
		async (request) => {
			return draftOperationResponse(
				await (await mailAccess()).retryDraftCleanup(request.operationId),
			);
		},
	);
}
