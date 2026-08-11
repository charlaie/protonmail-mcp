import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { BridgeConfig } from "../bridge/config.js";
import { loadBridgeConfig } from "../bridge/config.js";
import { createImapService } from "../bridge/imap.js";
import { sendEmail } from "../bridge/smtp.js";
import {
	canReadMailbox,
	canReadMessage,
	filterAllowedMessages,
	READ_POLICY_NOT_CONFIGURED,
} from "../policy/enforcement.js";
import { loadReadPolicy } from "../policy/store.js";
import { safeErrorMessage } from "../shared/errors.js";
import {
	createSendApprovalController,
	type SendApprovalController,
} from "./elicitation.js";
import { jsonResponse, textResponse } from "./responses.js";
import {
	CreateDraftSchema,
	EditDraftSchema,
	GetMessageSchema,
	GetThreadSchema,
	SearchMessagesSchema,
	SendEmailSchema,
} from "./schemas.js";

type ImapService = ReturnType<typeof createImapService>;
type Mailbox = Awaited<ReturnType<ImapService["listMailboxes"]>>[number];

function findDraftsMailbox(mailboxes: Mailbox[]) {
	return (
		mailboxes.find((mailbox) => mailbox.specialUse === "\\Drafts") ??
		mailboxes.find((mailbox) => mailbox.flags.includes("\\Drafts")) ??
		mailboxes.find((mailbox) => mailbox.path === "Drafts")
	);
}

async function requireDraftsMailboxAccess(imap: ImapService) {
	const policy = await loadReadPolicy();

	if (!policy) {
		return {
			ok: false as const,
			response: textResponse(
				"Draft access is not configured. Ask the user to run `protonmail-mcp setup` in a terminal and include the Drafts mailbox so this MCP server may create and edit drafts.",
			),
		};
	}

	const draftsMailbox = findDraftsMailbox(await imap.listMailboxes());

	if (!draftsMailbox) {
		return {
			ok: false as const,
			response: textResponse(
				"Drafts mailbox was not found. Proton Bridge did not expose a mailbox marked as Drafts; use list_mailboxes to inspect available mailboxes.",
			),
		};
	}

	if (!canReadMailbox(policy, draftsMailbox.path)) {
		return {
			ok: false as const,
			response: jsonResponse({
				status: "blocked_by_read_policy",
				mailbox: draftsMailbox.path,
				reason: `Draft support needs access to the ${draftsMailbox.path} mailbox. Run protonmail-mcp setup and include ${draftsMailbox.path} in the allowed mailboxes.`,
			}),
		};
	}

	return {
		ok: true as const,
		mailbox: draftsMailbox.path,
	};
}

export function createServer() {
	const sendApproval = createSendApprovalController();
	const server = new McpServer(
		{
			name: "protonmail-mcp",
			version: "1.0.0",
		},
		{
			requestState: {
				verify: sendApproval.verifyRequestState,
			},
		},
	);

	const bridgeConfig = loadBridgeConfig();
	const imap = createImapService(bridgeConfig);
	registerTools(server, bridgeConfig, imap, sendApproval);

	return server;
}

function registerTools(
	server: McpServer,
	bridgeConfig: BridgeConfig,
	imap: ImapService,
	sendApproval: SendApprovalController,
) {
	server.registerTool(
		"send_email",
		{
			title: "Send email",
			description:
				"Send a plain-text email through Proton Bridge SMTP. Use only when the user explicitly asks to send an email and the full recipient list, subject, and body are known. The server will request mandatory user approval before delivery; if approval is declined or unavailable, no email is sent.",
			inputSchema: SendEmailSchema,
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		async (input, ctx) => {
			try {
				const approval = await sendApproval.requireApproval(input, ctx);

				if (approval.kind !== "approved") {
					return approval.response;
				}

				const result = await sendEmail(bridgeConfig, input);
				return jsonResponse(result);
			} catch (error) {
				return textResponse(`Email not sent: ${safeErrorMessage(error)}`);
			}
		},
	);

	server.registerTool(
		"list_mailboxes",
		{
			title: "List mailboxes",
			description:
				"List Proton Bridge IMAP mailboxes/folders. Use this before searching if the target mailbox path is unknown. Each mailbox includes allowedByReadPolicy: true only when the current read policy allows searching and reading that exact mailbox path; false means the mailbox exists but search_messages and get_message will not return messages from it.",
			inputSchema: z.object({}),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		async () => {
			try {
				const policy = await loadReadPolicy();
				const mailboxes = await imap.listMailboxes();
				return jsonResponse(
					mailboxes.map((mailbox) => ({
						...mailbox,
						allowedByReadPolicy: policy
							? canReadMailbox(policy, mailbox.path)
							: false,
					})),
				);
			} catch (error) {
				return textResponse(
					`Unable to list mailboxes: ${safeErrorMessage(error)}`,
				);
			}
		},
	);

	server.registerTool(
		"create_draft",
		{
			title: "Create draft",
			description:
				"Create a plain-text email draft in the Proton Bridge Drafts mailbox. Requires the Drafts mailbox to be allowed by the local read policy. This never sends email; it only saves a draft and returns its IMAP UID when available.",
			inputSchema: CreateDraftSchema,
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		async (input) => {
			try {
				const access = await requireDraftsMailboxAccess(imap);

				if (!access.ok) {
					return access.response;
				}

				const result = await imap.createDraft({
					...input,
					mailbox: access.mailbox,
				});
				return jsonResponse(result);
			} catch (error) {
				return textResponse(`Draft not created: ${safeErrorMessage(error)}`);
			}
		},
	);

	server.registerTool(
		"edit_draft",
		{
			title: "Edit draft",
			description:
				"Replace an existing plain-text draft in the Proton Bridge Drafts mailbox by IMAP UID. IMAP cannot edit message bodies in place, so this creates a replacement draft, deletes the old draft, and returns the new UID. Requires the Drafts mailbox to be allowed by the local read policy.",
			inputSchema: EditDraftSchema,
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		async (input) => {
			try {
				const access = await requireDraftsMailboxAccess(imap);

				if (!access.ok) {
					return access.response;
				}

				const result = await imap.editDraft({
					...input,
					mailbox: access.mailbox,
				});
				return jsonResponse(result);
			} catch (error) {
				return textResponse(`Draft not edited: ${safeErrorMessage(error)}`);
			}
		},
	);

	server.registerTool(
		"search_messages",
		{
			title: "Search messages",
			description:
				"Search read-only Proton Bridge IMAP message metadata. Requires the user to configure read policy with `protonmail-mcp setup` first. Returns summaries only, not full message bodies, and filters results by the configured read policy.",
			inputSchema: SearchMessagesSchema,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		async (input) => {
			try {
				const policy = await loadReadPolicy();

				if (!policy) {
					return textResponse(READ_POLICY_NOT_CONFIGURED);
				}

				if (!canReadMailbox(policy, input.mailbox)) {
					return jsonResponse({
						status: "blocked_by_read_policy",
						messages: [],
						reason: `Mailbox ${input.mailbox} is not allowed by the read policy.`,
					});
				}

				const messages = await imap.searchMessages(input);
				return jsonResponse({
					status: "ok",
					messages: filterAllowedMessages(policy, input.mailbox, messages),
				});
			} catch (error) {
				return textResponse(
					`Unable to search messages: ${safeErrorMessage(error)}`,
				);
			}
		},
	);

	server.registerTool(
		"get_message",
		{
			title: "Get message",
			description:
				"Read one Proton Bridge IMAP message by mailbox and UID as parsed plain text. Requires the user to configure read policy with `protonmail-mcp setup` first. Use a UID returned by search_messages. Does not return HTML or attachment contents.",
			inputSchema: GetMessageSchema,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		async (input) => {
			try {
				const policy = await loadReadPolicy();

				if (!policy) {
					return textResponse(READ_POLICY_NOT_CONFIGURED);
				}

				if (!canReadMailbox(policy, input.mailbox)) {
					return textResponse(
						`Message not returned. Mailbox ${input.mailbox} is not allowed by the read policy.`,
					);
				}

				const summary = await imap.getMessageSummary(input);

				if (!summary) {
					return textResponse(
						`Message UID ${input.uid} was not found in mailbox ${input.mailbox}.`,
					);
				}

				if (
					!canReadMessage(policy, { mailbox: input.mailbox, message: summary })
				) {
					return textResponse(
						"Message not returned. Sender is not allowed by the read policy.",
					);
				}

				const message = await imap.getMessage(input);

				if (!message) {
					return textResponse(
						`Message UID ${input.uid} was not found in mailbox ${input.mailbox}.`,
					);
				}

				return jsonResponse(message);
			} catch (error) {
				return textResponse(
					`Unable to get message: ${safeErrorMessage(error)}`,
				);
			}
		},
	);

	server.registerTool(
		"get_thread",
		{
			title: "Get thread",
			description:
				"Best-effort reconstruction of an email reply chain from one anchor message. Uses standard Message-ID, References, and In-Reply-To headers across read-policy-allowed Proton Bridge IMAP mailboxes. This is not a native Proton or Gmail-style conversation ID.",
			inputSchema: GetThreadSchema,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		async (input) => {
			try {
				const policy = await loadReadPolicy();

				if (!policy) {
					return textResponse(READ_POLICY_NOT_CONFIGURED);
				}

				if (!canReadMailbox(policy, input.mailbox)) {
					return textResponse(
						`Thread not returned. Anchor mailbox ${input.mailbox} is not allowed by the read policy.`,
					);
				}

				const requestedMailboxes = input.mailboxes ?? policy.allowedMailboxes;
				const mailboxes = requestedMailboxes.filter((mailbox) =>
					canReadMailbox(policy, mailbox),
				);

				if (mailboxes.length === 0) {
					return jsonResponse({
						status: "blocked_by_read_policy",
						messages: [],
						reason: "No requested mailboxes are allowed by the read policy.",
					});
				}

				const summary = await imap.getMessageSummary(input);

				if (!summary) {
					return textResponse(
						`Message UID ${input.uid} was not found in mailbox ${input.mailbox}.`,
					);
				}

				if (
					!canReadMessage(policy, { mailbox: input.mailbox, message: summary })
				) {
					return textResponse(
						"Thread not returned. Anchor message sender is not allowed by the read policy.",
					);
				}

				const thread = await imap.getThread({
					...input,
					mailboxes,
				});

				if (!thread) {
					return textResponse(
						`Message UID ${input.uid} was not found in mailbox ${input.mailbox}.`,
					);
				}

				const allowedMessages = thread.messages.filter((message) =>
					canReadMessage(policy, {
						mailbox: message.mailbox,
						message,
					}),
				);

				const messages = input.includeText
					? await Promise.all(
							allowedMessages.map(async (message) => {
								const fullMessage = await imap.getMessage({
									mailbox: message.mailbox,
									uid: message.uid,
								});

								return fullMessage
									? {
											...fullMessage,
											mailbox: message.mailbox,
											threadKey: message.threadKey,
										}
									: message;
							}),
						)
					: allowedMessages;

				return jsonResponse({
					status: "ok",
					threadKey: thread.threadKey,
					reconstruction: "best_effort_message_headers",
					messages,
				});
			} catch (error) {
				return textResponse(`Unable to get thread: ${safeErrorMessage(error)}`);
			}
		},
	);
}
