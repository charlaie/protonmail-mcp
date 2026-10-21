import { z } from "zod";
import type { ImapService } from "@/bridge/imap/service.js";
import type { MailAccess } from "@/mail/access.js";
import { CreateMailboxSchema } from "@/mail/inbox/creation.js";
import {
	type InboxOperation,
	ManageMessageSchema,
} from "@/mail/inbox/model.js";
import { jsonResponse } from "@/mcp/protocol/responses.js";
import type { ToolRegistry } from "@/mcp/protocol/tool-registry.js";
import {
	GetOperationSchema,
	ListOperationsSchema,
} from "@/operations/identity.js";
import {
	CreateMailboxOutputSchema,
	InboxCapabilitiesOutputSchema,
	InboxOperationOutputSchema,
	InboxOperationsOutputSchema,
} from "./schemas.js";

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
	server: ToolRegistry;
	imap: ImapService;
	mailAccess: () => Promise<MailAccess>;
}) {
	const { server, imap, mailAccess } = input;
	server.registerTool(
		"create_mailbox",
		{
			title: "Create folder or label",
			inputSchema: CreateMailboxSchema,
			outputSchema: CreateMailboxOutputSchema,
			annotations: { ...read, readOnlyHint: false },
			description:
				"Ensure a custom folder or label exists under Bridge's advertised Folders or Labels namespace. Supply a single name and kind; folders may specify an existing custom parent path. Requires explicit tool and creation-kind grants. An existing selectable path is success. Retry with the same arguments after refreshing list_mailboxes. Creating a mailbox does not grant read or message-write access to it; use local setup for those permissions. Never deletes or renames mailboxes.",
		},
		async (request) =>
			jsonResponse(await (await mailAccess()).createMailbox(request)),
	);
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
			return jsonResponse(await (await mailAccess()).getInboxCapabilities());
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
			return inboxOperationResponse(
				await (await mailAccess()).manageInbox(request),
			);
		},
	);
	server.registerTool(
		"get_inbox_operation",
		{
			title: "Get inbox operation",
			inputSchema: GetOperationSchema,
			outputSchema: InboxOperationOutputSchema,
			annotations: read,
			description:
				"Inspect local durable inbox operation metadata for this account, including during policy outages. Never changes flags, moves messages or reads bodies. Reserved or submitting operations can be active or interrupted and cannot be automatically released. Aborted means no command was dispatched and the reservation was released.",
		},
		async (request) => {
			return inboxOperationResponse(await imap.inbox.get(request.operationId));
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
				"List this account's reserved, submitting or uncertain inbox operations without message bodies, including during policy outages. Paginate with limit and offset; nextOffset null ends the list. Never mutates mail.",
		},
		async (request) => {
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
		},
	);
	server.registerTool(
		"reconcile_inbox_operation",
		{
			title: "Reconcile uncertain inbox operation",
			inputSchema: GetOperationSchema,
			outputSchema: InboxOperationOutputSchema,
			annotations: { ...read, readOnlyHint: false },
			description:
				"Verify desired flag state or exact Message-ID/metadata and folder placement for an uncertain inbox operation. Requires current source/destination write and sender policy. Never STOREs, MOVEs or deletes. Ambiguous or missing evidence keeps uncertainty. Reserved or submitting operations cannot be automatically reconciled because their writer may still run; inspect those manually. Completed and aborted operations are terminal.",
		},
		async (request) => {
			return inboxOperationResponse(
				await (await mailAccess()).reconcileInboxOperation(request.operationId),
			);
		},
	);
}
