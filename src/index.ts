#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { SearchMessagesSchema } from "@/bridge/imap/reading/requests.js";
import { createImapService } from "@/bridge/imap/service.js";
import {
	CLIENTS,
	type ClientName,
	ClientNameSchema,
	clientConfigSavedMessage,
	installClientConfig,
	type LaunchSpecification,
	launchSpecification,
	prepareClientInstallation,
	renderClientConfig,
} from "@/cli/clients/configuration.js";
import {
	type DiagnosticResult,
	diagnoseServer,
} from "@/cli/diagnostics/service.js";
import { getConfigFilePath } from "@/config/paths.js";
import { requireServerConfig, type ServerConfig } from "@/config/store.js";
import { createMailAccess } from "@/mail/access.js";
import { GetMessageSchema } from "@/mail/identity.js";
import { createServer } from "@/mcp/server.js";
import { createToolAccess } from "@/policy/access.js";
import { safeErrorMessage } from "@/shared/errors.js";

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

type Command = z.infer<typeof CommandSchema>;

type BridgeCommand = Extract<Command, `bridge:${string}`>;

const SetupSectionSchema = z.enum([
	"all",
	"credentials",
	"permissions",
	"client",
]);

const ServerNameSchema = z
	.string()
	.regex(
		/^[a-zA-Z0-9_-]+$/,
		"Server names may contain only letters, digits, underscores and hyphens.",
	);

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

	const command = parseCommand(rawCommand);
	const configPath = resolve(values.config ?? getConfigFilePath());
	const serverName = ServerNameSchema.parse(values.name ?? "protonmail");
	if (command === "setup") {
		await runSetup(configPath, values.section, serverName);
		return;
	}
	if (command === "doctor") {
		await runDoctor(configPath, values.json);
		return;
	}

	const config = await requireServerConfig(configPath);
	switch (command) {
		case "serve":
			serve(config);
			return;
		case "client-config":
			await runClientConfig({
				configPath,
				serverName,
				client: values.client,
				install: values.install,
				output: values.output,
			});
			return;
		case "policy": {
			const { runPolicyCommand } = await import("@/cli/policy.js");
			await runPolicyCommand(config.storage.policyFile);
			return;
		}
		case "reset-policy": {
			const { runResetPolicyCommand } = await import("@/cli/policy.js");
			await runResetPolicyCommand(config.storage.policyFile);
			return;
		}
		case "bridge:list":
		case "bridge:search":
		case "bridge:read":
			await runBridgeCommand(command, config, args);
			return;
		default: {
			const exhaustive: never = command;
			return exhaustive;
		}
	}
}

function parseCommand(rawCommand: string): Command {
	const parsed = CommandSchema.safeParse(rawCommand);
	if (!parsed.success)
		throw new Error(
			`Unknown command ${JSON.stringify(rawCommand)}.\n${usage()}`,
		);
	return parsed.data;
}

async function runSetup(
	configPath: string,
	section: string | undefined,
	serverName: string,
) {
	const { runSetupCommand } = await import("@/cli/setup/command.js");
	await runSetupCommand({
		configPath,
		entryPath,
		section: SetupSectionSchema.parse(section ?? "all"),
		serverName,
	});
}

async function runDoctor(configPath: string, json: boolean | undefined) {
	const results = await collectDiagnostics(configPath);
	if (json) printJson({ configPath, results });
	else for (const result of results) console.log(formatDiagnostic(result));
	if (results.some((result) => result.status === "failed"))
		process.exitCode = 1;
}

async function collectDiagnostics(
	configPath: string,
): Promise<DiagnosticResult[]> {
	try {
		const config = await requireServerConfig(configPath);
		return await diagnoseServer(
			config,
			launchSpecification({ configPath, entryPath }),
		);
	} catch (error) {
		return [
			{
				check: "configuration",
				status: "failed",
				message: safeErrorMessage(error),
				fix: `Run protonmail-mcp setup --config ${JSON.stringify(configPath)}.`,
			},
		];
	}
}

function formatDiagnostic(result: DiagnosticResult) {
	const summary = `${result.status.toUpperCase()} ${result.check}: ${result.message}`;
	if (result.status !== "failed") return summary;
	return `${summary}\n  Fix: ${result.fix}`;
}

function serve(config: ServerConfig) {
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
}

async function runClientConfig(input: {
	configPath: string;
	serverName: string;
	client: string | undefined;
	install: string | undefined;
	output: string | undefined;
}) {
	const { configPath, serverName, install, output } = input;
	const client = ClientNameSchema.parse(input.client);
	const launch = launchSpecification({ configPath, entryPath });
	if (install && output)
		throw new Error("Choose either --install or --output.");

	if (install) await installInteractively(client, install, launch, serverName);
	else {
		const snippet = renderClientConfig(client, launch, serverName);
		if (output) {
			await writeFile(output, snippet, { flag: "wx", mode: 0o600 });
			console.log(`Snippet saved to ${resolve(output)}.`);
		} else console.log(snippet);
	}
	console.error(CLIENTS[client].instructions);
}

async function installInteractively(
	client: ClientName,
	path: string,
	launch: LaunchSpecification,
	serverName: string,
) {
	const { confirm, requireTerminal } = await import("@/cli/setup/prompts.js");
	requireTerminal();
	const plan = await prepareClientInstallation(
		client,
		path,
		launch,
		serverName,
	);
	console.log(plan.updated);
	const approved = await confirm(
		`Save changes to ${plan.path} and back up any existing file?`,
		false,
	);
	if (!approved) return;
	console.log(clientConfigSavedMessage(await installClientConfig(plan)));
}

async function runBridgeCommand(
	command: BridgeCommand,
	config: ServerConfig,
	args: string[],
) {
	const account = config.bridge.user;
	const policyFile = config.storage.policyFile;
	const access = createToolAccess(account, policyFile);
	const imap = createImapService(config.bridge);
	if (command === "bridge:list") {
		await access.require("list_mailboxes");
		printJson(await imap.listMailboxes());
		return;
	}

	const mail = await createMailAccess(imap, account, policyFile);
	if (command === "bridge:search") {
		const [mailbox, ...queryWords] = args;
		await access.require("search_messages");
		const request = SearchMessagesSchema.parse({
			mailbox,
			query: queryWords.length ? queryWords.join(" ") : undefined,
			limit: 10,
		});
		printJson(await mail.searchMessages(request));
		return;
	}

	const [mailbox, uid, uidValidity] = args;
	await access.require("get_message");
	const request = GetMessageSchema.parse({
		mailbox,
		uid: uid !== undefined && /^\d+$/.test(uid) ? Number(uid) : undefined,
		uidValidity,
	});
	printJson(await mail.getMessage(request));
}

main().catch((error) => {
	if (error instanceof Error && error.name === "SetupCancelled") {
		console.error(error.message);
		return;
	}
	console.error(safeErrorMessage(error));
	process.exitCode = 1;
});
