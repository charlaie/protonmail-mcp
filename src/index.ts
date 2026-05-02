#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadDotEnv } from "./cli/env.js";
import {
	runPolicyCommand,
	runResetPolicyCommand,
	runSetupCommand,
} from "./cli/policy.js";
import { loadBridgeConfig } from "./bridge/config.js";
import { getMessage, listMailboxes, searchMessages } from "./bridge/imap.js";
import { sendEmail } from "./bridge/smtp.js";
import { createServer } from "./mcp/server.js";
import { safeErrorMessage } from "./shared/errors.js";

function usage() {
	return [
		"Usage:",
		"  protonmail-mcp                  Start MCP stdio server",
		"  protonmail-mcp setup            Configure local read policy",
		"  protonmail-mcp policy           Show local read policy",
		"  protonmail-mcp reset-policy     Reset local read policy",
		"  protonmail-mcp bridge:list      Test Bridge IMAP mailbox listing",
		"  protonmail-mcp bridge:search [query]",
		"  protonmail-mcp bridge:read <mailbox> <uid>",
		"  protonmail-mcp bridge:send-test <recipient>",
	].join("\n");
}

function printJson(value: unknown) {
	console.log(JSON.stringify(value, null, 2));
}

async function runMcpServer() {
	loadBridgeConfig();

	const server = createServer();
	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error("Protonmail MCP Server running on stdio");
}

async function runBridgeCommand(command: string, args: string[]) {
	const config = loadBridgeConfig();

	switch (command) {
		case "bridge:list":
			printJson(await listMailboxes(config));
			return;
		case "bridge:search":
			printJson(
				await searchMessages(config, {
					mailbox: "INBOX",
					query: args.join(" ").trim() || undefined,
					limit: 10,
				}),
			);
			return;
		case "bridge:read": {
			const mailbox = args[0];
			const uid = Number(args[1]);

			if (!mailbox || !Number.isInteger(uid) || uid <= 0) {
				throw new Error(
					"bridge:read requires <mailbox> and positive integer <uid>.",
				);
			}

			printJson(await getMessage(config, { mailbox, uid }));
			return;
		}
		case "bridge:send-test": {
			const recipient = args[0];

			if (!recipient) {
				throw new Error("bridge:send-test requires <recipient>.");
			}

			printJson(
				await sendEmail(config, {
					to: [recipient],
					subject: "Proton Bridge MCP test",
					text: "This is a direct Proton Bridge SMTP test from protonmail-mcp.",
				}),
			);
			return;
		}
		default:
			throw new Error(usage());
	}
}

async function main() {
	const [command, ...args] = process.argv.slice(2);

	if (!command) {
		await runMcpServer();
		return;
	}

	await loadDotEnv();

	switch (command) {
		case "setup":
			await runSetupCommand();
			return;
		case "policy":
			await runPolicyCommand();
			return;
		case "reset-policy":
			await runResetPolicyCommand();
			return;
		case "bridge:list":
		case "bridge:search":
		case "bridge:read":
		case "bridge:send-test":
			await runBridgeCommand(command, args);
			return;
		case "help":
		case "--help":
		case "-h":
			console.log(usage());
			return;
		default:
			throw new Error(usage());
	}
}

main().catch((error) => {
	console.error("Fatal error in main():", safeErrorMessage(error));
	process.exit(1);
});
