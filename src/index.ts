#!/usr/bin/env node

import { loadEnvFile } from "node:process";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadBridgeConfig } from "./bridge/config.js";
import { createImapService } from "./bridge/imap.js";
import {
	GetMessageSchema,
	SearchMessagesSchema,
	SendEmailSchema,
} from "./bridge/schemas.js";
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
		"  protonmail-mcp bridge:search <mailbox> [query]",
		"  protonmail-mcp bridge:read <mailbox> <uid> <uidValidity>",
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
			const input = SearchMessagesSchema.parse({
				mailbox: args[0],
				query: args.length > 1 ? args.slice(1).join(" ") : undefined,
				limit: 10,
			});
			printJson(await imap.searchMessages(input));
			return;
		}
		case "bridge:read": {
			const input = GetMessageSchema.parse({
				mailbox: args[0],
				uid: /^\d+$/.test(args[1] ?? "") ? Number(args[1]) : undefined,
				uidValidity: args[2],
			});
			const result = await imap.getMessage(input);
			if (result.kind === "unavailable") throw new Error(result.reason);
			if (result.kind === "denied")
				throw new Error("Message access was denied.");
			if (result.kind !== "found")
				throw new Error(
					`Message UID ${input.uid} was not found in ${input.mailbox}.`,
				);
			printJson(result.value);
			return;
		}
		case "bridge:send-test": {
			printJson(
				await sendEmail(
					config,
					SendEmailSchema.parse({
						to: args[0],
						subject: "Proton Bridge MCP test",
						text: "This is a direct Proton Bridge SMTP test from protonmail-mcp.",
					}),
				),
			);
			return;
		}
		default:
			throw new Error(usage());
	}
}

async function main() {
	const [command, ...args] = process.argv.slice(2);
	if (command === "help" || command === "--help" || command === "-h") {
		console.log(usage());
		return;
	}
	loadEnvFileIfPresent();

	if (!command) {
		runMcpServer();
		return;
	}

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
		default:
			throw new Error(usage());
	}
}

main().catch((error) => {
	console.error(safeErrorMessage(error));
	process.exit(1);
});
