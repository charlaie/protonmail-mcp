import { z } from "zod";
import {
	GetThreadSchema,
	SearchMessagesSchema,
} from "@/bridge/imap/reading/requests.js";
import type { ImapService } from "@/bridge/imap/service.js";
import type { MailAccess } from "@/mail/access.js";
import { GetMessageSchema } from "@/mail/identity.js";
import { BatchGetMessagesSchema } from "@/mail/reading/batch.js";
import { READ_ONLY_TOOL } from "@/mcp/protocol/annotations.js";
import { jsonResponse } from "@/mcp/protocol/responses.js";
import type { ToolRegistry } from "@/mcp/protocol/tool-registry.js";
import { canReadMailbox, readPolicyStatus } from "@/policy/enforcement.js";
import { loadReadPolicy } from "@/policy/store.js";
import {
	BatchGetMessagesOutputSchema,
	GetMessageOutputSchema,
	MailboxesOutputSchema,
	SearchOutputSchema,
	ThreadOutputSchema,
} from "./schemas.js";

type MailboxLister = Pick<ImapService, "listMailboxes">;

async function mailboxesWithReadPolicy(
	imap: MailboxLister,
	account: string,
	policyFile: string | undefined,
) {
	const policy = await loadReadPolicy(policyFile);
	const policyStatus = readPolicyStatus(policy, account);
	const mailboxes = await imap.listMailboxes();

	return mailboxes.map((mailbox) => {
		const selectable = !mailbox.flags.includes("\\Noselect");
		const allowedByReadPolicy =
			policyStatus === "ok" &&
			policy !== null &&
			selectable &&
			canReadMailbox(policy, mailbox.path);
		return { ...mailbox, selectable, policyStatus, allowedByReadPolicy };
	});
}

export function registerReadTools(input: {
	server: ToolRegistry;
	imap: MailboxLister;
	account: string;
	policyFile?: string;
	mailAccess: () => Promise<MailAccess>;
}) {
	const { server, imap, account, policyFile, mailAccess } = input;

	server.registerTool(
		"list_mailboxes",
		{
			title: "List mailboxes",
			description:
				"List Proton Bridge mailboxes and exact paths. selectable indicates whether the path holds messages. allowedByReadPolicy indicates mailbox access for this account; sender restrictions may still apply. policyStatus explains missing or mismatched policy and requires setup when it is not ok.",
			inputSchema: z.object({}),
			outputSchema: MailboxesOutputSchema,
			annotations: READ_ONLY_TOOL,
		},
		async () =>
			jsonResponse({
				mailboxes: await mailboxesWithReadPolicy(imap, account, policyFile),
			}),
	);

	server.registerTool(
		"search_messages",
		{
			title: "Search messages",
			description:
				"Search allowed Proton Bridge mailboxes. Returns newest allowed messages by received date with descending UID ties. projection=ids returns complete mailbox/UID/UIDVALIDITY references only. Sender policy applies to both projections. Follow nextCursor with identical arguments to continue; null ends the search. Cursors expire after 15 minutes and reset on restart or policy change; omit cursor to restart. New arrivals after the first page are excluded, deletions disappear. Bodies and attachments are omitted. Run protonmail-mcp setup to configure access.",
			inputSchema: SearchMessagesSchema,
			outputSchema: SearchOutputSchema,
			annotations: READ_ONLY_TOOL,
		},
		async (query) => {
			const mail = await mailAccess();
			return jsonResponse({
				status: "ok",
				...(await mail.searchMessages(query)),
			});
		},
	);

	server.registerTool(
		"get_message",
		{
			title: "Get message",
			description:
				"Read an allowed message by mailbox, UID, and UIDVALIDITY from search_messages. UIDVALIDITY detects mailbox resets. Returns plain text, converting HTML-only messages. Attachment contents are omitted. Messages over 10 MiB must be read in Proton Mail.",
			inputSchema: GetMessageSchema,
			outputSchema: GetMessageOutputSchema,
			annotations: READ_ONLY_TOOL,
		},
		async (identity) => {
			const mail = await mailAccess();
			return jsonResponse(await mail.getMessage(identity));
		},
	);

	server.registerTool(
		"batch_get_messages",
		{
			title: "Read a batch of messages",
			description:
				"Read 1–20 complete mailbox/UID/UIDVALIDITY references sequentially, preserving request order. Uses get_message policy and plain-text behavior; no attachments or writes. Per-item kinds distinguish found, denied, not_found, stale_identity, unavailable, failed and budget_exhausted. Stops before returning more than 500,000 text characters or 1 MiB of JSON; bodies are never truncated. Retry budget-exhausted items in a smaller batch or use get_message. A completed batch has isError=false even with item failures; outer authorization/validation failures have isError=true.",
			inputSchema: BatchGetMessagesSchema,
			outputSchema: BatchGetMessagesOutputSchema,
			annotations: READ_ONLY_TOOL,
		},
		async (request) => {
			const mail = await mailAccess();
			return jsonResponse(await mail.batchGetMessages(request));
		},
	);

	server.registerTool(
		"get_thread",
		{
			title: "Get thread",
			description:
				"Reconstruct an allowed email reply chain using exact Message-ID, References, and In-Reply-To tokens across allowed mailboxes. Bridge internal/external message ID headers, when present, provide identity aliases for reply matching and deduplication; they are not conversation IDs. Standard-header reconstruction remains the fallback. Returns allowed messages up to limit and limitReached when the cap is reached. Set includeText=false for summaries. Each bodyStatus explains included or unavailable text. Bodies over 10 MiB require Proton Mail; thread text is limited to 500,000 characters, with get_message available for omitted bodies.",
			inputSchema: GetThreadSchema,
			outputSchema: ThreadOutputSchema,
			annotations: READ_ONLY_TOOL,
		},
		async (request) => {
			const mail = await mailAccess();
			return jsonResponse({
				status: "ok",
				reconstruction: "best_effort_message_headers",
				...(await mail.getThread(request)),
			});
		},
	);
}
