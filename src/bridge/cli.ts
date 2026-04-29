#!/usr/bin/env node

import { loadBridgeConfig } from "./config.js";
import { getMessage, listMailboxes, searchMessages } from "./imap.js";
import { sendEmail } from "./smtp.js";
import { safeErrorMessage } from "../shared/errors.js";

type Command = "list" | "search" | "read" | "send-test";

function usage() {
	return [
		"Usage:",
		"  pnpm bridge:list",
		"  pnpm bridge:search [query]",
		"  pnpm bridge:read <mailbox> <uid>",
		"  pnpm bridge:send-test <recipient>",
		"",
		"Environment is loaded from .env when using the package scripts.",
		"send-test sends a real email and is not MCP-elicitation gated.",
	].join("\n");
}

function printJson(value: unknown) {
	console.log(JSON.stringify(value, null, 2));
}

async function main() {
	const command = process.argv[2] as Command | undefined;
	const config = loadBridgeConfig();

	switch (command) {
		case "list": {
			printJson(await listMailboxes(config));
			return;
		}

		case "search": {
			const query = process.argv.slice(3).join(" ").trim();
			printJson(
				await searchMessages(config, {
					mailbox: "INBOX",
					query: query || undefined,
					limit: 10,
				}),
			);
			return;
		}

		case "read": {
			const mailbox = process.argv[3];
			const uid = Number(process.argv[4]);

			if (!mailbox || !Number.isInteger(uid) || uid <= 0) {
				throw new Error("bridge:read requires <mailbox> and positive integer <uid>.");
			}

			printJson(await getMessage(config, { mailbox, uid }));
			return;
		}

		case "send-test": {
			const recipient = process.argv[3];

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

main().catch((error) => {
	console.error(safeErrorMessage(error));
	process.exit(1);
});
