#!/usr/bin/env node

import { loadEnvFile } from "node:process";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadBridgeConfig } from "./bridge/config.js";
import { createImapService } from "./bridge/imap.js";
import { sendEmail } from "./bridge/smtp.js";
import { createServer } from "./mcp/server.js";
import {
	runPolicyCommand,
	runResetPolicyCommand,
	runSetupCommand,
} from "./policy/cli.js";
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

function loadEnvFileIfPresent(path = ".env") {
	try {
		loadEnvFile(path);
	} catch (error) {
		// ignore error if file not exists
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "ENOENT"
		) {
			return;
		}

		throw error;
	}
}

function runMcpServer() {
	serveStdio(() => createServer(), {
		onerror: (error) => {
			console.error(`MCP transport error: ${safeErrorMessage(error)}`);
		},
	});
	console.error("Protonmail MCP Server running on stdio");
}

async function runBridgeCommand(command: string, args: string[]) {
	const config = loadBridgeConfig();
	const imap = createImapService(config);

	switch (command) {
		case "bridge:list":
			printJson(await imap.listMailboxes());
			return;
		case "bridge:search": {
			const mailbox = args[0];
			const query = args.length > 1 ? args[1] : undefined;
			printJson(
				await imap.searchMessages({
					mailbox: mailbox,
					query: query,
					limit: 10,
				}),
			);
			return;
		}
		case "bridge:read": {
			const mailbox = args[0];
			const uid = Number(args[1]);

			if (!mailbox || !Number.isInteger(uid) || uid <= 0) {
				throw new Error(
					"bridge:read requires <mailbox> and positive integer <uid>.",
				);
			}

			printJson(await imap.getMessage({ mailbox, uid }));
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
		runMcpServer();
		return;
	}

	loadEnvFileIfPresent();

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
	console.error(error);
	console.error("Fatal error in main():", safeErrorMessage(error));
	process.exit(1);
});
