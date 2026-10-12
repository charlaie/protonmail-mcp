import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type BridgeConfig, loadBridgeConfig } from "../bridge/config.js";
import { createImapService, type ImapService } from "../bridge/imap.js";
import { composeReplyDraft } from "../bridge/replies.js";
import {
	CreateDraftSchema,
	CreateReplyDraftSchema,
	EditDraftSchema,
	GetMessageSchema,
	GetThreadSchema,
	SearchMessagesSchema,
} from "../bridge/schemas.js";
import { canReadMailbox, readPolicyStatus } from "../policy/enforcement.js";
import { createReadService } from "../policy/service.js";
import { loadReadPolicy } from "../policy/store.js";
import { createSendService, type SendService } from "../sending/service.js";
import { MailError } from "../shared/mail-error.js";
import { registerAttachmentTools } from "./attachments.js";
import {
	type ApprovalController,
	createApprovalController,
} from "./elicitation.js";
import {
	CreateDraftOutputSchema,
	EditDraftOutputSchema,
	GetMessageOutputSchema,
	MailboxesOutputSchema,
	SearchOutputSchema,
	ThreadOutputSchema,
} from "./output-schemas.js";
import { errorResponse, jsonResponse } from "./responses.js";
import { registerSendTools } from "./send-tools.js";

const READ_ONLY = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: true,
};
const WRITE = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: true,
};
const DESTRUCTIVE = { ...WRITE, destructiveHint: true };

async function respond(operation: () => Promise<object>) {
	try {
		return jsonResponse(await operation());
	} catch (error) {
		return errorResponse(error);
	}
}

export function createServer(
	options: {
		config?: BridgeConfig;
		imap?: ImapService;
		sends?: SendService;
		approval?: ApprovalController;
	} = {},
) {
	const config = options.config ?? loadBridgeConfig();
	const imap = options.imap ?? createImapService(config);
	const readService = () => createReadService(imap, config.user);
	const approval = options.approval ?? createApprovalController();
	const server = new McpServer(
		{ name: "protonmail-mcp", version: "1.0.0" },
		{
			requestState: { verify: approval.verifyRequestState },
		},
	);

	registerSendTools({
		server,
		config,
		sends: options.sends ?? createSendService(config),
		approval,
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
		() =>
			respond(async () => {
				const policy = await loadReadPolicy();
				const policyStatus = readPolicyStatus(policy, config.user);
				return {
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
				};
			}),
	);

	server.registerTool(
		"create_draft",
		{
			title: "Create draft",
			description:
				"Save a plain-text draft without sending it. Requires Drafts mailbox access. Recipients, subject, and body may be blank. Returns UID and UIDVALIDITY when Bridge provides them. Draft write access is controlled by the mailbox allowlist, independently of sender read restrictions.",
			inputSchema: CreateDraftSchema,
			outputSchema: CreateDraftOutputSchema,
			annotations: WRITE,
		},
		async (input) => {
			try {
				const mailbox = await (await readService()).requireDraftsMailbox();
				return jsonResponse(await imap.createDraft({ ...input, mailbox }));
			} catch (error) {
				return errorResponse(
					error instanceof MailError
						? error
						: new MailError(
								"OPERATION_FAILED",
								"Draft creation could not be confirmed. Inspect Drafts before retrying.",
								"reconcile",
								{ cause: error },
							),
				);
			}
		},
	);

	server.registerTool(
		"create_reply_draft",
		{
			title: "Create reply draft",
			inputSchema: CreateReplyDraftSchema,
			outputSchema: CreateDraftOutputSchema,
			annotations: WRITE,
			description:
				"Create a plain-text reply or reply-all draft from an allowed message identity. Derives recipients using Reply-To, excludes configured own addresses, never copies Bcc, and sets In-Reply-To and References. Requires authorized source reads and Drafts access. Never sends mail.",
		},
		async (input) => {
			try {
				const reads = await readService();
				const original = await reads.getMessage(input);
				const mailbox = await reads.requireDraftsMailbox();
				return jsonResponse(
					await imap.createDraft(
						composeReplyDraft(config, original, input, mailbox),
					),
				);
			} catch (error) {
				return errorResponse(
					error instanceof MailError
						? error
						: new MailError(
								"OPERATION_FAILED",
								"Reply draft creation could not be confirmed. Inspect Drafts before retrying.",
								"reconcile",
								{ cause: error },
							),
				);
			}
		},
	);

	server.registerTool(
		"edit_draft",
		{
			title: "Edit draft",
			description:
				"Replace the full contents of a plain-text draft by UID and UIDVALIDITY. Supply all recipients, subject, and body to retain; omitted values are cleared. Preserves reply headers. Drafts with HTML or attachments must be edited in Proton Mail. Creates a replacement and deletes the original; inspect partial outcomes before retrying. Requires Drafts mailbox access and UIDPLUS.",
			inputSchema: EditDraftSchema,
			outputSchema: EditDraftOutputSchema,
			annotations: DESTRUCTIVE,
		},
		async (input) => {
			try {
				const mailbox = await (await readService()).requireDraftsMailbox();
				const result = await imap.editDraft({ ...input, mailbox });
				return result.status === "updated"
					? jsonResponse(result)
					: {
							...jsonResponse({
								...result,
								retry:
									result.status === "replacement_created_old_delete_failed"
										? "reconcile"
										: result.status === "not_found"
											? "refresh_identity"
											: "never",
							}),
							isError: true,
						};
			} catch (error) {
				return errorResponse(
					error instanceof MailError
						? error
						: new MailError(
								"OPERATION_FAILED",
								"Draft update could not be confirmed. Inspect Drafts before retrying.",
								"reconcile",
								{ cause: error },
							),
				);
			}
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
		(input) =>
			respond(async () => ({
				status: "ok",
				messages: await (await readService()).searchMessages(input),
			})),
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
		(input) => respond(async () => (await readService()).getMessage(input)),
	);

	server.registerTool(
		"get_thread",
		{
			title: "Get thread",
			description:
				"Reconstruct an allowed email reply chain using exact Message-ID, References, and In-Reply-To tokens across allowed mailboxes. This is a best-effort header reconstruction. Returns allowed messages up to limit and limitReached when the cap is reached. Set includeText=false for summaries. Each bodyStatus explains included or unavailable text. Bodies over 10 MiB require Proton Mail; thread text is limited to 500,000 characters, with get_message available for omitted bodies.",
			inputSchema: GetThreadSchema,
			outputSchema: ThreadOutputSchema,
			annotations: READ_ONLY,
		},
		(input) =>
			respond(async () => ({
				status: "ok",
				reconstruction: "best_effort_message_headers",
				...(await (await readService()).getThread(input)),
			})),
	);

	registerAttachmentTools({ server, readService, approval });

	return server;
}
