import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { BridgeConfig } from "../bridge/config.js";
import { createImapService, type ImapService } from "../bridge/imap.js";
import {
	GetMessageSchema,
	GetThreadSchema,
	SearchMessagesSchema,
} from "../bridge/schemas.js";
import { createDraftStore } from "../drafts/store.js";
import { createInboxStore } from "../inbox/store.js";
import { createToolAccess } from "../policy/access.js";
import { canReadMailbox, readPolicyStatus } from "../policy/enforcement.js";
import { createReadService } from "../policy/service.js";
import { loadReadPolicy } from "../policy/store.js";
import { createSendService, type SendService } from "../sending/service.js";
import { createSendStore } from "../sending/store.js";
import { registerAttachmentTools } from "./attachments.js";
import { registerDraftTools } from "./draft-tools.js";
import {
	type ApprovalController,
	createApprovalController,
} from "./elicitation.js";
import { registerInboxTools } from "./inbox-tools.js";
import {
	GetMessageOutputSchema,
	MailboxesOutputSchema,
	SearchOutputSchema,
	ThreadOutputSchema,
} from "./output-schemas.js";
import { jsonResponse } from "./responses.js";
import { registerSendTools } from "./send-tools.js";
import { ToolRegistry } from "./tool-registry.js";

const READ_ONLY = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: true,
};
export function createServer(options: {
	config: BridgeConfig;
	policyFile?: string;
	operationsDirectory?: string;
	imap?: ImapService;
	sends?: SendService;
	approval?: ApprovalController;
}) {
	const config = options.config;
	const imap =
		options.imap ??
		createImapService(
			config,
			undefined,
			createDraftStore(config.user, options.operationsDirectory),
			createInboxStore(config.user, options.operationsDirectory),
		);
	const readService = () =>
		createReadService(imap, config.user, options.policyFile);
	const approval = options.approval ?? createApprovalController();
	const mcp = new McpServer(
		{ name: "protonmail-mcp", version: "1.0.0" },
		{
			requestState: { verify: approval.verifyRequestState },
		},
	);

	const access = createToolAccess(config.user, options.policyFile);
	const server = new ToolRegistry(mcp, access);

	registerSendTools({
		server,
		config,
		sends:
			options.sends ??
			createSendService(config, {
				store: createSendStore(config.user, options.operationsDirectory),
			}),
		approval,
		access,
		readService,
	});

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
			const policy = await loadReadPolicy(options.policyFile);
			const policyStatus = readPolicyStatus(policy, config.user);
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

	registerDraftTools({ server, config, imap, readService });

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
				messages: await (await readService()).searchMessages(input),
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
		async (input) =>
			jsonResponse(await (await readService()).getMessage(input)),
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
				...(await (await readService()).getThread(input)),
			}),
	);

	registerAttachmentTools({ server, readService, approval });
	registerInboxTools({ server, imap, readService });

	return mcp;
}
