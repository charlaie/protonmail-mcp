import { z } from "zod";
import {
	GetThreadSchema,
	SearchMessagesSchema,
} from "../../../bridge/imap/reading/requests.js";
import type { ImapService } from "../../../bridge/imap/service.js";
import type { MailAccess } from "../../../mail/access.js";
import { GetMessageSchema } from "../../../mail/identity.js";
import {
	canReadMailbox,
	readPolicyStatus,
} from "../../../policy/enforcement.js";
import { loadReadPolicy } from "../../../policy/store.js";
import { jsonResponse } from "../../protocol/responses.js";
import type { ToolRegistry } from "../../protocol/tool-registry.js";
import {
	GetMessageOutputSchema,
	MailboxesOutputSchema,
	SearchOutputSchema,
	ThreadOutputSchema,
} from "./schemas.js";

const READ_ONLY = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: true,
};

export function registerReadTools(input: {
	server: ToolRegistry;
	imap: Pick<ImapService, "listMailboxes">;
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
				"List Proton Bridge mailboxes and exact paths. selectable indicates whether the path holds messages. allowedByReadPolicy indicates mailbox access for this account; sender restrictions may still apply. policyStatus explains missing, legacy, or mismatched policy and requires setup when it is not ok.",
			inputSchema: z.object({}),
			outputSchema: MailboxesOutputSchema,
			annotations: READ_ONLY,
		},
		async () => {
			const policy = await loadReadPolicy(policyFile);
			const policyStatus = readPolicyStatus(policy, account);
			return jsonResponse({
				mailboxes: (await imap.listMailboxes()).map((mailbox) => ({
					...mailbox,
					selectable: !mailbox.flags.includes("\\Noselect"),
					policyStatus,
					allowedByReadPolicy:
						policyStatus === "ok" &&
						policy !== null &&
						!mailbox.flags.includes("\\Noselect") &&
						canReadMailbox(policy, mailbox.path),
				})),
			});
		},
	);

	server.registerTool(
		"search_messages",
		{
			title: "Search messages",
			description:
				"Search allowed Proton Bridge mailboxes. Returns newest allowed summaries by received date, up to limit, after applying sender policy. Bodies and attachments are omitted. Keep UIDVALIDITY with each UID for later reads or edits. Run protonmail-mcp setup to configure access.",
			inputSchema: SearchMessagesSchema,
			outputSchema: SearchOutputSchema,
			annotations: READ_ONLY,
		},
		async (input) =>
			jsonResponse({
				status: "ok",
				messages: await (await mailAccess()).searchMessages(input),
			}),
	);

	server.registerTool(
		"get_message",
		{
			title: "Get message",
			description:
				"Read an allowed message by mailbox, UID, and UIDVALIDITY from search_messages. UIDVALIDITY detects mailbox resets. Returns plain text, converting HTML-only messages. Attachment contents are omitted. Messages over 10 MiB must be read in Proton Mail.",
			inputSchema: GetMessageSchema,
			outputSchema: GetMessageOutputSchema,
			annotations: READ_ONLY,
		},
		async (input) => jsonResponse(await (await mailAccess()).getMessage(input)),
	);

	server.registerTool(
		"get_thread",
		{
			title: "Get thread",
			description:
				"Reconstruct an allowed email reply chain using exact Message-ID, References, and In-Reply-To tokens across allowed mailboxes. Bridge internal/external message ID headers, when present, provide identity aliases for reply matching and deduplication; they are not conversation IDs. Standard-header reconstruction remains the fallback. Returns allowed messages up to limit and limitReached when the cap is reached. Set includeText=false for summaries. Each bodyStatus explains included or unavailable text. Bodies over 10 MiB require Proton Mail; thread text is limited to 500,000 characters, with get_message available for omitted bodies.",
			inputSchema: GetThreadSchema,
			outputSchema: ThreadOutputSchema,
			annotations: READ_ONLY,
		},
		async (input) =>
			jsonResponse({
				status: "ok",
				reconstruction: "best_effort_message_headers",
				...(await (await mailAccess()).getThread(input)),
			}),
	);
}
