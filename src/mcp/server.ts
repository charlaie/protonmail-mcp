import { McpServer } from "@modelcontextprotocol/server";
import type { BridgeConfig } from "../bridge/config.js";
import { createImapService, type ImapService } from "../bridge/imap/service.js";
import { createMailAccess } from "../mail/access.js";
import {
	createSendService,
	type SendService,
} from "../mail/sending/service.js";
import { createSendWorkflow } from "../mail/sending/workflow.js";
import { createOperationJournal } from "../operations/journal.js";
import { createToolAccess } from "../policy/access.js";
import {
	type ApprovalController,
	createApprovalController,
} from "./protocol/elicitation.js";
import { ToolRegistry } from "./protocol/tool-registry.js";
import { registerAttachmentTools } from "./tools/attachments/register.js";
import { registerDraftTools } from "./tools/drafts/register.js";
import { registerInboxTools } from "./tools/inbox/register.js";
import { registerReadTools } from "./tools/reading/register.js";
import { registerSendTools } from "./tools/sending/register.js";

export function createServer(options: {
	config: BridgeConfig;
	policyFile?: string;
	operationsDirectory?: string;
	imap?: ImapService;
	sends?: SendService;
	approval?: ApprovalController;
}) {
	const config = options.config;
	const journal = createOperationJournal(
		config.user,
		options.operationsDirectory,
	);
	const imap =
		options.imap ??
		createImapService(config, undefined, journal.drafts, journal.inbox);
	const sends =
		options.sends ??
		createSendService(config, {
			store: journal.sends,
		});
	const mailAccess = () =>
		createMailAccess(imap, config.user, options.policyFile);
	const approval = options.approval ?? createApprovalController();
	const mcp = new McpServer(
		{ name: "protonmail-mcp", version: "1.0.0" },
		{ requestState: { verify: approval.verifyRequestState } },
	);
	const access = createToolAccess(config.user, options.policyFile);
	const server = new ToolRegistry(mcp, access);
	registerReadTools({
		server,
		imap,
		account: config.user,
		policyFile: options.policyFile,
		mailAccess,
	});
	registerDraftTools({ server, config, imap, mailAccess });
	registerSendTools({
		server,
		config,
		sends,
		approval,
		workflow: createSendWorkflow({ config, sends, access, mailAccess }),
	});
	registerAttachmentTools({ server, mailAccess, approval });
	registerInboxTools({ server, imap, mailAccess });
	return mcp;
}
