import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ImapService } from "../bridge/imap.js";
import {
	GetSendOperationSchema,
	ListOperationsSchema,
} from "../bridge/schemas.js";
import {
	InboxCapabilitiesOutputSchema,
	type InboxOperation,
	InboxOperationOutputSchema,
	InboxOperationsOutputSchema,
	ManageMessageSchema,
} from "../inbox/model.js";
import type { createReadService } from "../policy/service.js";
import { errorResponse, jsonResponse } from "./responses.js";

const read = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: true,
};
export function inboxOperationResponse(record: InboxOperation) {
	const { requestHash: _requestHash, ...publicRecord } = record;
	return {
		...jsonResponse({
			...publicRecord,
			retry: record.outcome.status === "uncertain" ? "reconcile" : "never",
		}),
		isError: record.outcome.status !== "completed",
	};
}
export function registerInboxTools(input: {
	server: McpServer;
	imap: ImapService;
	readService: () => Promise<Awaited<ReturnType<typeof createReadService>>>;
}) {
	const { server, imap, readService } = input;
	server.registerTool(
		"get_inbox_capabilities",
		{
			title: "Inbox capabilities and permissions",
			inputSchema: z.object({}),
			outputSchema: InboxCapabilitiesOutputSchema,
			annotations: read,
			description:
				"Inspect this account's configured inbox write actions and allowed exact folder/label paths. Native MOVE support gates moves, archive, Trash, and labels. Actual flag writes also require mailbox permanent flag support. Sender restrictions still apply. Drafts remain protected.",
		},
		async () => {
			try {
				return jsonResponse(await (await readService()).getInboxCapabilities());
			} catch (error) {
				return errorResponse(error);
			}
		},
	);
	server.registerTool(
		"manage_message",
		{
			title: "Manage inbox message",
			inputSchema: ManageMessageSchema,
			outputSchema: InboxOperationOutputSchema,
			annotations: { ...read, readOnlyHint: false, destructiveHint: true },
			description:
				"Change one non-draft message's read state, star, folder or label under explicit local inbox write permissions and sender policy. Supply operationId UUID, mailbox, UID and UIDVALIDITY; reuse identical arguments on retries. Native MOVE only, no copy/delete fallback or permanent deletion. Both source and destination require permission. apply_label moves from an ordinary folder into an exact Labels path; remove_label moves from a Labels path into a chosen ordinary folder and can change its residence. Draft and attempted-send identities are refused. An uncertain operation is never repeated automatically.",
		},
		async (request) => {
			try {
				return inboxOperationResponse(
					await (await readService()).manageInbox(request),
				);
			} catch (error) {
				return errorResponse(error);
			}
		},
	);
	server.registerTool(
		"get_inbox_operation",
		{
			title: "Get inbox operation",
			inputSchema: GetSendOperationSchema,
			outputSchema: InboxOperationOutputSchema,
			annotations: read,
			description:
				"Inspect local durable inbox operation metadata for this account, including during policy outages. Never changes flags, moves messages or reads bodies. A submitting operation can be active or interrupted and cannot be automatically released.",
		},
		async (request) => {
			try {
				return inboxOperationResponse(
					await imap.inbox.get(request.operationId),
				);
			} catch (error) {
				return errorResponse(error);
			}
		},
	);
	server.registerTool(
		"list_inbox_operations",
		{
			title: "List unresolved inbox operations",
			inputSchema: ListOperationsSchema,
			outputSchema: InboxOperationsOutputSchema,
			annotations: read,
			description:
				"List this account's submitting or uncertain inbox operations without message bodies, including during policy outages. Paginate with limit and offset; nextOffset null ends the list. Never mutates mail.",
		},
		async (request) => {
			try {
				const records = await imap.inbox.list(request.limit, request.offset);
				return jsonResponse({
					operations: records.map(
						(record) => inboxOperationResponse(record).structuredContent,
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
		"reconcile_inbox_operation",
		{
			title: "Reconcile uncertain inbox operation",
			inputSchema: GetSendOperationSchema,
			outputSchema: InboxOperationOutputSchema,
			annotations: { ...read, readOnlyHint: false },
			description:
				"Verify desired flag state or exact Message-ID/metadata and folder placement for an uncertain inbox operation. Requires current source/destination write and sender policy. Never STOREs, MOVEs or deletes. Ambiguous or missing evidence keeps uncertainty. Submitting reservations cannot be automatically reconciled because an older command may still run; inspect those manually.",
		},
		async (request) => {
			try {
				return inboxOperationResponse(
					await (await readService()).reconcileInboxOperation(
						request.operationId,
					),
				);
			} catch (error) {
				return errorResponse(error);
			}
		},
	);
}
