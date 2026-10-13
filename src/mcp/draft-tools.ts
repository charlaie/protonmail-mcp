import type { McpServer } from "@modelcontextprotocol/server";
import type { BridgeConfig } from "../bridge/config.js";
import type { ImapService } from "../bridge/imap.js";
import { composeReplyDraft } from "../bridge/replies.js";
import {
	CreateDraftSchema,
	CreateReplyDraftSchema,
	EditDraftSchema,
	GetMessageSchema,
	GetSendOperationSchema,
	ListOperationsSchema,
} from "../bridge/schemas.js";
import type { DraftOperation } from "../drafts/model.js";
import type { createReadService } from "../policy/service.js";
import {
	DraftOperationOutputSchema,
	GetDraftOutputSchema,
	ListDraftOperationsOutputSchema,
} from "./output-schemas.js";
import { errorResponse, jsonResponse } from "./responses.js";

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
			retry: record.outcome.status === "completed" ? "never" : "reconcile",
		}),
		isError: record.outcome.status !== "completed",
	};
}
export function registerDraftTools(input: {
	server: McpServer;
	config: BridgeConfig;
	imap: ImapService;
	readService: () => Promise<Awaited<ReturnType<typeof createReadService>>>;
}) {
	const { server, config, imap, readService } = input;
	server.registerTool(
		"create_draft",
		{
			title: "Create draft",
			inputSchema: CreateDraftSchema,
			outputSchema: DraftOperationOutputSchema,
			annotations: write,
			description:
				"Save a text draft with optional bounded base64 attachments and inline images without sending. Supply a new operationId UUID and reuse it with identical arguments on retries. Empty recipients, subject and body are allowed. Durable APPEND intent prevents duplicates after restart; appending means uncertain and requires reconciliation. Requires allowed Drafts mailbox access.",
		},
		async (request) => {
			try {
				const mailbox = await (await readService()).requireDraftsMailbox();
				return draftOperationResponse(
					await imap.createDraft({ ...request, mailbox }),
				);
			} catch (error) {
				return errorResponse(error);
			}
		},
	);
	server.registerTool(
		"create_reply_draft",
		{
			title: "Create reply draft",
			inputSchema: CreateReplyDraftSchema,
			outputSchema: DraftOperationOutputSchema,
			annotations: write,
			description:
				"Create a plain-text reply or reply-all using allowed source reads, Reply-To, own aliases, and reply headers. Never copies original Bcc or sends mail. Supply an operationId UUID; identical retries return the durable operation without creating another reply. Requires Drafts access.",
		},
		async (request) => {
			try {
				const reads = await readService();
				const mailbox = await reads.requireDraftsMailbox();
				const previous = await imap.existingDraftOperation(
					request.operationId,
					request,
				);
				if (previous) return draftOperationResponse(previous);
				const original = await reads.getMessage(request);
				return draftOperationResponse(
					await imap.createDraft(
						composeReplyDraft(config, original, request, mailbox),
						request,
					),
				);
			} catch (error) {
				return errorResponse(error);
			}
		},
	);
	server.registerTool(
		"get_draft",
		{
			title: "Read editable draft",
			inputSchema: GetMessageSchema,
			outputSchema: GetDraftOutputSchema,
			annotations: read,
			description:
				"Read a policy-authorized draft, including Bcc, byte-free file/image manifests and its revision token. Keep revision for edit_draft expectedRevision. Empty unfinished drafts are supported. Arbitrary HTML, unsupported media, oversized drafts, and disallowed senders are refused.",
		},
		async (request) => {
			try {
				return jsonResponse(await (await readService()).getDraft(request));
			} catch (error) {
				return errorResponse(error);
			}
		},
	);
	server.registerTool(
		"edit_draft",
		{
			title: "Edit draft",
			inputSchema: EditDraftSchema,
			outputSchema: DraftOperationOutputSchema,
			annotations: { ...write, destructiveHint: true },
			description:
				"Patch a readable supported draft using its UID, UIDVALIDITY and expectedRevision from get_draft. Omitted fields and attachment/inline-image groups are preserved; [] clears the specified recipient or payload group and an empty string clears subject or body. Requires a new operationId UUID, reused on retries. Preserves sender and reply headers. Drafts with an attempted send or unresolved replacement are blocked. Creates one replacement, then safely deletes the unchanged original. Uncertain results require recovery; never change IDs to retry.",
		},
		async (request) => {
			try {
				return draftOperationResponse(
					await (await readService()).editDraft(request),
				);
			} catch (error) {
				return errorResponse(error);
			}
		},
	);
	server.registerTool(
		"get_draft_operation",
		{
			title: "Get draft operation",
			inputSchema: GetSendOperationSchema,
			outputSchema: DraftOperationOutputSchema,
			annotations: read,
			description:
				"Inspect this account's durable draft operation by UUID, including after restart. Returns recovery identity and status without message body. Does not append, send or delete mail.",
		},
		async (request) => {
			try {
				return draftOperationResponse(
					await imap.getDraftOperation(request.operationId),
				);
			} catch (error) {
				return errorResponse(error);
			}
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
			try {
				const records = await imap.listDraftOperations(
					request.limit,
					request.offset,
				);
				return jsonResponse({
					operations: records.map(
						(record) => draftOperationResponse(record).structuredContent,
					),
					nextOffset:
						records.length === request.limit
							? request.offset + request.limit
							: null,
				});
			} catch (error) {
				return errorResponse(error);
			}
		},
	);
	server.registerTool(
		"reconcile_draft_operation",
		{
			title: "Reconcile draft operation",
			inputSchema: GetSendOperationSchema,
			outputSchema: DraftOperationOutputSchema,
			annotations: write,
			description:
				"Resolve uncertain APPEND only through one exact operation Message-ID and unchanged canonical content in allowed Drafts. No match keeps uncertainty; conflicting or duplicate copies are refused. Never appends, submits SMTP or deletes mail. Use retry_draft_cleanup separately when an edit's replacement was found.",
		},
		async (request) => {
			try {
				return draftOperationResponse(
					await (await readService()).reconcileDraftOperation(
						request.operationId,
					),
				);
			} catch (error) {
				return errorResponse(error);
			}
		},
	);
	server.registerTool(
		"retry_draft_cleanup",
		{
			title: "Retry draft replacement cleanup",
			inputSchema: GetSendOperationSchema,
			outputSchema: DraftOperationOutputSchema,
			annotations: { ...write, destructiveHint: true },
			description:
				"Retry only deletion of an edit operation's recorded original. Verifies the replacement still exists unchanged and the original has the recorded revision and UIDVALIDITY. Requires current sender/mailbox read authorization and UIDPLUS. Never appends, sends, or edits contents. Uncertain APPEND must first be reconciled.",
		},
		async (request) => {
			try {
				return draftOperationResponse(
					await (await readService()).retryDraftCleanup(request.operationId),
				);
			} catch (error) {
				return errorResponse(error);
			}
		},
	);
}
