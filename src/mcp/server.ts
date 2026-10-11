import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { loadBridgeConfig } from "../bridge/config.js";
import { createImapService } from "../bridge/imap.js";
import {
	CreateDraftSchema,
	EditDraftSchema,
	GetMessageSchema,
	GetThreadSchema,
	SearchMessagesSchema,
	SendEmailSchema,
} from "../bridge/schemas.js";
import { sendEmail } from "../bridge/smtp.js";
import { canReadMailbox, readPolicyStatus } from "../policy/enforcement.js";
import { createReadService } from "../policy/service.js";
import { loadReadPolicy } from "../policy/store.js";
import { safeErrorMessage } from "../shared/errors.js";
import { registerAttachmentTools } from "./attachments.js";
import { createSendApprovalController } from "./elicitation.js";
import { errorResponse, jsonResponse } from "./responses.js";

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

async function respond(operation: () => Promise<unknown>) {
	try {
		return jsonResponse(await operation());
	} catch (error) {
		return errorResponse(safeErrorMessage(error));
	}
}

export function createServer() {
	const config = loadBridgeConfig();
	const imap = createImapService(config);
	const readService = () => createReadService(imap, config.user);
	const sendApproval = createSendApprovalController(config.user);
	const server = new McpServer(
		{ name: "protonmail-mcp", version: "1.0.0" },
		{
			requestState: { verify: sendApproval.verifyRequestState },
		},
	);

	server.registerTool(
		"send_email",
		{
			title: "Send email",
			description:
				"Send a plain-text email through Proton Bridge SMTP. Use only when the user explicitly asks to send and the recipients, subject, and body are known. Mandatory user approval shows the complete message before delivery. Check partial or uncertain delivery outcomes before retrying.",
			inputSchema: SendEmailSchema,
			annotations: DESTRUCTIVE,
		},
		async (input, ctx) => {
			try {
				const approval = await sendApproval.requireApproval(input, ctx);
				if (approval.kind !== "approved") return approval.response;
			} catch (error) {
				return errorResponse(
					`Email not sent. Approval could not be completed: ${safeErrorMessage(error)}`,
				);
			}
			try {
				const result = await sendEmail(config, input);
				return result.status === "partially_sent"
					? errorResponse({
							...result,
							reason:
								"Some recipients were rejected. Email was sent to accepted recipients. Do not resend to them; check Sent before retrying rejected recipients.",
						})
					: jsonResponse(result);
			} catch (error) {
				return errorResponse(
					`Email delivery could not be confirmed: ${safeErrorMessage(error)}. Check Proton Mail Sent before retrying to avoid sending a duplicate.`,
				);
			}
		},
	);

	server.registerTool(
		"list_mailboxes",
		{
			title: "List mailboxes",
			description:
				"List Proton Bridge mailboxes and exact paths. selectable indicates whether the path holds messages. allowedByReadPolicy indicates mailbox access for this account; sender restrictions may still apply. policyStatus explains missing, legacy, or mismatched policy and requires setup when it is not ok.",
			inputSchema: z.object({}),
			annotations: READ_ONLY,
		},
		() =>
			respond(async () => {
				const policy = await loadReadPolicy();
				const policyStatus = readPolicyStatus(policy, config.user);
				return (await imap.listMailboxes()).map((mailbox) => ({
					...mailbox,
					selectable: !mailbox.flags.includes("\\Noselect"),
					policyStatus,
					allowedByReadPolicy:
						policyStatus === "ok" &&
						policy !== null &&
						!mailbox.flags.includes("\\Noselect") &&
						canReadMailbox(policy, mailbox.path),
				}));
			}),
	);

	server.registerTool(
		"create_draft",
		{
			title: "Create draft",
			description:
				"Save a plain-text draft without sending it. Requires Drafts mailbox access. Recipients, subject, and body may be blank. Returns UID and UIDVALIDITY when Bridge provides them. Draft write access is controlled by the mailbox allowlist, independently of sender read restrictions.",
			inputSchema: CreateDraftSchema,
			annotations: WRITE,
		},
		async (input) => {
			try {
				const mailbox = await (await readService()).requireDraftsMailbox();
				return jsonResponse(await imap.createDraft({ ...input, mailbox }));
			} catch (error) {
				return errorResponse(
					`Draft creation could not be confirmed: ${safeErrorMessage(error)}. Inspect Drafts before retrying.`,
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
			annotations: DESTRUCTIVE,
		},
		async (input) => {
			try {
				const mailbox = await (await readService()).requireDraftsMailbox();
				const result = await imap.editDraft({ ...input, mailbox });
				return result.status === "updated"
					? jsonResponse(result)
					: errorResponse(result);
			} catch (error) {
				return errorResponse(
					`Draft update could not be confirmed: ${safeErrorMessage(error)}. Inspect Drafts before retrying.`,
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
			annotations: READ_ONLY,
		},
		(input) =>
			respond(async () => ({
				status: "ok",
				reconstruction: "best_effort_message_headers",
				...(await (await readService()).getThread(input)),
			})),
	);

	registerAttachmentTools({ server, readService });

	return server;
}
