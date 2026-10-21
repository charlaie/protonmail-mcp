import { McpServer } from "@modelcontextprotocol/server";
import type { BridgeConfig } from "../bridge/config.js";
import { createImapService, type ImapService } from "../bridge/imap/service.js";
import { createMailAccess } from "../mail/access.js";
import { createDraftWorkflow } from "../mail/drafts/workflow.js";
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

type CreateServerOptions = {
	config: BridgeConfig;
	policyFile?: string;
	operationsDirectory?: string;
	imap?: ImapService;
	sends?: SendService;
	approval?: ApprovalController;
};

export function createServer(options: CreateServerOptions) {
	const { config, policyFile } = options;
	const account = config.user;

	const journal = createOperationJournal(account, options.operationsDirectory);
	const imap =
		options.imap ??
		createImapService(config, {
			draftStore: journal.drafts,
			inboxStore: journal.inbox,
		});
	const sends =
		options.sends ?? createSendService(config, { store: journal.sends });
	const mailAccess = () => createMailAccess(imap, account, policyFile);
	const approval = options.approval ?? createApprovalController();

	const mcp = new McpServer(
		{ name: "protonmail-mcp", version: "1.0.0" },
		{ requestState: { verify: approval.verifyRequestState } },
	);
	const access = createToolAccess(account, policyFile);
	const server = new ToolRegistry(mcp, access);

	registerReadTools({ server, imap, account, policyFile, mailAccess });
	registerDraftTools({
		server,
		config,
		imap,
		mailAccess,
		workflow: createDraftWorkflow({ config, drafts: imap.drafts, mailAccess }),
	});
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
