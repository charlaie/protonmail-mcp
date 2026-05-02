import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { loadBridgeConfig } from "../bridge/config.js";
import {
	getMessage,
	getMessageSummary,
	listMailboxes,
	searchMessages,
} from "../bridge/imap.js";
import { sendEmail } from "../bridge/smtp.js";
import {
	canReadMailbox,
	canReadMessage,
	filterAllowedMessages,
	READ_POLICY_NOT_CONFIGURED,
} from "../policy/enforcement.js";
import { loadReadPolicy } from "../policy/store.js";
import { safeErrorMessage } from "../shared/errors.js";
import { jsonResponse, textResponse } from "../shared/responses.js";
import { requireSendApproval } from "./elicitation.js";
import {
	GetMessageSchema,
	SearchMessagesSchema,
	SendEmailSchema,
} from "./schemas.js";

export function createServer() {
	const server = new McpServer({
		name: "protonmail-mcp",
		version: "1.0.0",
	});

	registerTools(server);

	return server;
}

function registerTools(server: McpServer) {
	server.registerTool(
		"send_email",
		{
			description:
				"Send a plain-text email through Proton Bridge SMTP. Use only when the user explicitly asks to send an email and the full recipient list, subject, and body are known. The server will request mandatory user approval before delivery; if approval is declined or unavailable, no email is sent.",
			inputSchema: SendEmailSchema,
		},
		async (input) => {
			try {
				const approved = await requireSendApproval(server, input);

				if (!approved) {
					return textResponse(
						"Email not sent. User approval was not received.",
					);
				}

				const result = await sendEmail(loadBridgeConfig(), input);
				return jsonResponse(result);
			} catch (error) {
				return textResponse(`Email not sent: ${safeErrorMessage(error)}`);
			}
		},
	);

	server.registerTool(
		"list_mailboxes",
		{
			description:
				"List Proton Bridge IMAP mailboxes/folders. Use this before searching if the target mailbox path is unknown.",
			inputSchema: z.object({}),
		},
		async () => {
			try {
				const mailboxes = await listMailboxes(loadBridgeConfig());
				return jsonResponse(mailboxes);
			} catch (error) {
				return textResponse(
					`Unable to list mailboxes: ${safeErrorMessage(error)}`,
				);
			}
		},
	);

	server.registerTool(
		"search_messages",
		{
			description:
				"Search read-only Proton Bridge IMAP message metadata. Requires the user to configure read policy with `protonmail-mcp setup` first. Returns summaries only, not full message bodies, and filters results by the configured read policy.",
			inputSchema: SearchMessagesSchema,
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

				const messages = await searchMessages(loadBridgeConfig(), input);
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
			description:
				"Read one Proton Bridge IMAP message by mailbox and UID as parsed plain text. Requires the user to configure read policy with `protonmail-mcp setup` first. Use a UID returned by search_messages. Does not return HTML or attachment contents.",
			inputSchema: GetMessageSchema,
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

				const config = loadBridgeConfig();
				const summary = await getMessageSummary(config, input);

				if (!summary) {
					return textResponse(
						`Message UID ${input.uid} was not found in mailbox ${input.mailbox}.`,
					);
				}

				if (!canReadMessage(policy, { mailbox: input.mailbox, message: summary })) {
					return textResponse(
						"Message not returned. Sender is not allowed by the read policy.",
					);
				}

				const message = await getMessage(config, input);

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
}
