import {
	GetThreadSchema,
	SearchMessagesSchema,
} from "@/bridge/imap/reading/requests.js";
import type { ImapService } from "@/bridge/imap/service.js";
import type { MailAccess } from "@/mail/access.js";
import { BatchGetMessagesSchema } from "@/mail/reading/batch.js";
import { ListPageSchema, listPage } from "@/mail/reading/list-page.js";
import {
	boundedMessage,
	messageView,
	ReadMessageSchema,
} from "@/mail/reading/view.js";
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
				"List Proton Bridge mailboxes and exact paths, 20 per page by default (limit up to 100). Continue with offset=nextOffset until null; pages reflect the current list. selectable indicates whether the path holds messages. allowedByReadPolicy indicates mailbox access for this account; sender restrictions may still apply. policyStatus explains missing or mismatched policy and requires setup when it is not ok.",
			inputSchema: ListPageSchema,
			outputSchema: MailboxesOutputSchema,
			annotations: READ_ONLY_TOOL,
		},
		async (request) => {
			const mailboxes = await mailboxesWithReadPolicy(
				imap,
				account,
				policyFile,
			);
			mailboxes.sort((a, b) => a.path.localeCompare(b.path));
			const page = listPage(mailboxes, request);
			return jsonResponse({
				mailboxes: page.items,
				nextOffset: page.nextOffset,
			});
		},
	);

	server.registerTool(
		"search_messages",
		{
			title: "Search messages",
			description:
				"Search allowed Proton Bridge mailboxes. Returns newest allowed messages by received date with descending UID ties, 10 per page by default. Summary address lists are capped at 20 entries; omitted reports left-out counts. projection=ids returns complete mailbox/UID/UIDVALIDITY references only. Sender policy applies to both projections. Follow nextCursor with identical arguments to continue; null ends the search. Cursors expire after 15 minutes and reset on restart or policy change; omit cursor to restart. New arrivals after the first page are excluded, deletions disappear. Bodies and attachments are omitted. Run protonmail-mcp setup to configure access.",
			inputSchema: SearchMessagesSchema,
			outputSchema: SearchOutputSchema,
			annotations: READ_ONLY_TOOL,
		},
		async (query) => {
			const mail = await mailAccess();
			const page = await mail.searchMessages(query);
			return jsonResponse({
				status: "ok",
				...(page.projection === "summary"
					? { ...page, messages: page.messages.map(boundedMessage) }
					: page),
			});
		},
	);

	server.registerTool(
		"get_message",
		{
			title: "Get message",
			description:
				"Read an allowed message by mailbox, UID, and UIDVALIDITY from search_messages. UIDVALIDITY detects mailbox resets. Returns a plain-text body page, converting HTML-only messages: 4,000 characters by default, at most 16,000 with textLimit. Follow textPage.nextOffset as textOffset with the same identity until null. Each page rechecks access. Address lists are capped at 20 entries and references keep the 10 newest IDs; omitted reports left-out counts. Attachment contents are omitted. Messages over 10 MiB must be read in Proton Mail.",
			inputSchema: ReadMessageSchema,
			outputSchema: GetMessageOutputSchema,
			annotations: READ_ONLY_TOOL,
		},
		async (identity) => {
			const mail = await mailAccess();
			return jsonResponse(
				messageView(
					await mail.getMessage(identity, { reuseContent: true }),
					identity,
				),
			);
		},
	);

	server.registerTool(
		"batch_get_messages",
		{
			title: "Read a batch of messages",
			description:
				"Read 1–20 complete mailbox/UID/UIDVALIDITY references sequentially, preserving request order. Uses get_message policy, plain-text behavior and bounded metadata; no attachments or writes. Each found item returns the first body page of up to textLimit characters (default 4000); continue with get_message textOffset when textPage.nextOffset is not null. Per-item kinds distinguish found, denied, not_found, stale_identity, unavailable, failed and budget_exhausted. Stops before returning more than 32,000 text characters or 128 KiB of JSON. Retry budget-exhausted items in a smaller batch, with a smaller textLimit, or with get_message. A completed batch has isError=false even with item failures; outer authorization/validation failures have isError=true.",
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
				"Reconstruct an allowed email reply chain using exact Message-ID, References, and In-Reply-To tokens across allowed mailboxes. Bridge internal/external message ID headers, when present, provide identity aliases for reply matching and deduplication; they are not conversation IDs. Standard-header reconstruction remains the fallback. Returns up to limit allowed messages (default 10) in chronological order; limitReached=true means more related messages were found, and the result keeps the requested message plus the newest others. Discovery scans up to 1000 candidates and 100 header searches independently of limit. discoveryComplete=false means the work budget was reached and newer messages may remain undiscovered. Defaults to summaries without bodies; set includeText=true to request bodies. Each bodyStatus explains included or unavailable text. Thread text is limited to 32,000 characters, filled newest first; use get_message for omitted bodies. Bodies over 10 MiB require Proton Mail. Address lists are capped at 20 entries and references keep the 10 newest IDs.",
			inputSchema: GetThreadSchema,
			outputSchema: ThreadOutputSchema,
			annotations: READ_ONLY_TOOL,
		},
		async (request) => {
			const mail = await mailAccess();
			const thread = await mail.getThread(request);
			return jsonResponse({
				status: "ok",
				reconstruction: "best_effort_message_headers",
				...thread,
				messages: thread.messages.map(boundedMessage),
			});
		},
	);
}
