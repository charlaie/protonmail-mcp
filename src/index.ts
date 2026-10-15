#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { createImapService } from "./bridge/imap.js";
import { GetMessageSchema, SearchMessagesSchema } from "./bridge/schemas.js";
import {
	CLIENTS,
	ClientNameSchema,
	launchSpecification,
	renderClientConfig,
} from "./clients/configuration.js";
import { getConfigFilePath } from "./config/paths.js";
import { requireServerConfig } from "./config/store.js";
import {
	type DiagnosticResult,
	diagnoseServer,
} from "./diagnostics/service.js";
import { createServer } from "./mcp/server.js";
import { createToolAccess } from "./policy/access.js";
import { createReadService } from "./policy/service.js";
import { safeErrorMessage } from "./shared/errors.js";

const entryPath = fileURLToPath(import.meta.url);
const CommandSchema = z.enum([
	"serve",
	"setup",
	"doctor",
	"client-config",
	"policy",
	"reset-policy",
	"bridge:list",
	"bridge:search",
	"bridge:read",
]);
function usage() {
	return [
		"Usage:",
		"  protonmail-mcp [serve]                    Start MCP stdio server",
		"  protonmail-mcp setup                      Configure Bridge, permissions and clients",
		"  protonmail-mcp doctor [--json]            Check configuration and connectivity without sending mail",
		"  protonmail-mcp client-config --client <claude|codex|vscode|cursor>",
		"  protonmail-mcp policy                     Show the access policy",
		"  protonmail-mcp reset-policy               Remove the access policy, keeping the journal",
		"  protonmail-mcp bridge:list                List Bridge mailboxes",
		"  protonmail-mcp bridge:search <mailbox> [query]",
		"  protonmail-mcp bridge:read <mailbox> <uid> <uidValidity>",
		"",
		"Options:",
		`  --config <path>                          Default: ${getConfigFilePath()}`,
		"  --section <all|credentials|permissions|client>  Setup section",
		"  --name <name>                            Client entry name; default protonmail",
		"  --output <path>                          Save a new client configuration snippet",
		"  --install <path>                         Preview and merge into a client config after confirmation",
		"  --help                                   Show this help",
	].join("\n");
}

function printJson(value: unknown) {
	console.log(JSON.stringify(value, null, 2));
}

async function main() {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			config: { type: "string" },
			section: { type: "string" },
			client: { type: "string" },
			name: { type: "string" },
			output: { type: "string" },
			install: { type: "string" },
			json: { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
	});
	const [rawCommand = "serve", ...args] = positionals;
	if (values.help || rawCommand === "help") {
		console.log(usage());
		return;
	}
	const parsedCommand = CommandSchema.safeParse(rawCommand);
	if (!parsedCommand.success)
		throw new Error(
			`Unknown command ${JSON.stringify(rawCommand)}.\n${usage()}`,
		);
	const command = parsedCommand.data;
	const configPath = resolve(values.config ?? getConfigFilePath());
	const serverName = z
		.string()
		.regex(
			/^[a-zA-Z0-9_-]+$/,
			"Server names may contain only letters, digits, underscores and hyphens.",
		)
		.parse(values.name ?? "protonmail");
	if (command === "setup") {
		const { runSetupCommand } = await import("./setup/command.js");
		await runSetupCommand({
			configPath: configPath,
			entryPath: entryPath,
			section: z
				.enum(["all", "credentials", "permissions", "client"])
				.parse(values.section ?? "all"),
			serverName: serverName,
		});
		return;
	}
	if (command === "doctor") {
		let results: DiagnosticResult[];
		try {
			const config = await requireServerConfig(configPath);
			results = await diagnoseServer(
				config,
				launchSpecification({ configPath: configPath, entryPath: entryPath }),
			);
		} catch (error) {
			results = [
				{
					check: "configuration",
					status: "failed",
					message: safeErrorMessage(error),
					fix: `Run protonmail-mcp setup --config ${JSON.stringify(configPath)}.`,
				},
			];
		}
		if (values.json) printJson({ configPath, results });
		else
			for (const result of results)
				console.log(
					`${result.status.toUpperCase()} ${result.check}: ${result.message}${result.status === "failed" ? `\n  Fix: ${result.fix}` : ""}`,
				);
		if (results.some((result) => result.status === "failed"))
			process.exitCode = 1;
		return;
	}
	const config = await requireServerConfig(configPath);
	switch (command) {
		case "serve":
			serveStdio(
				() =>
					createServer({
						config: config.bridge,
						policyFile: config.storage.policyFile,
						operationsDirectory: config.storage.operationsDirectory,
					}),
				{
					onerror: () =>
						console.error(
							"MCP transport failed. Run protonmail-mcp doctor with this configuration.",
						),
				},
			);
			return;
		case "client-config": {
			const client = ClientNameSchema.parse(values.client);
			const launch = launchSpecification({
				configPath: configPath,
				entryPath: entryPath,
			});
			const snippet = renderClientConfig(client, launch, serverName);
			if (values.install && values.output)
				throw new Error("Choose either --install or --output.");
			if (values.install) {
				const { prepareClientInstallation, installClientConfig } = await import(
					"./clients/configuration.js"
				);
				const { answer, requireTerminal } = await import("./setup/prompts.js");
				const prompts = await import("@clack/prompts");
				requireTerminal();
				const plan = await prepareClientInstallation(
					client,
					values.install,
					launch,
					serverName,
				);
				console.log(plan.updated);
				if (
					await answer(
						prompts.confirm({
							message: `Save changes to ${plan.path} and back up any existing file?`,
							initialValue: false,
						}),
					)
				) {
					const backup = await installClientConfig(plan);
					console.log(
						`Client configuration saved.${backup ? ` Backup: ${backup}` : ""}`,
					);
				}
			} else if (values.output) {
				await writeFile(values.output, snippet, { flag: "wx", mode: 0o600 });
				console.log(`Snippet saved to ${resolve(values.output)}.`);
			} else console.log(snippet);
			console.error(CLIENTS[client].instructions);
			return;
		}
		case "policy": {
			const { runPolicyCommand } = await import("./policy/cli.js");
			await runPolicyCommand(config.storage.policyFile);
			return;
		}
		case "reset-policy": {
			const { runResetPolicyCommand } = await import("./policy/cli.js");
			await runResetPolicyCommand(config.storage.policyFile);
			return;
		}
		case "bridge:list":
		case "bridge:search":
		case "bridge:read": {
			const access = createToolAccess(
				config.bridge.user,
				config.storage.policyFile,
			);
			const imap = createImapService(config.bridge);
			if (command === "bridge:list") {
				await access.require("list_mailboxes");
				printJson(await imap.listMailboxes());
				return;
			}
			const reads = await createReadService(
				imap,
				config.bridge.user,
				config.storage.policyFile,
			);
			if (command === "bridge:search") {
				await access.require("search_messages");
				printJson(
					await reads.searchMessages(
						SearchMessagesSchema.parse({
							mailbox: args[0],
							query: args.length > 1 ? args.slice(1).join(" ") : undefined,
							limit: 10,
						}),
					),
				);
				return;
			}
			await access.require("get_message");
			printJson(
				await reads.getMessage(
					GetMessageSchema.parse({
						mailbox: args[0],
						uid: /^\d+$/.test(args[1] ?? "") ? Number(args[1]) : undefined,
						uidValidity: args[2],
					}),
				),
			);
			return;
		}
		default: {
			const exhaustive: never = command;
			return exhaustive;
		}
	}
}

main().catch((error) => {
	if (error instanceof Error && error.name === "SetupCancelled") {
		console.error(error.message);
		return;
	}
	console.error(safeErrorMessage(error));
	process.exitCode = 1;
});
