import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	applyEdits,
	modify,
	type ParseError,
	parse as parseJsonc,
} from "jsonc-parser";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { z } from "zod";
import { withSettingsLocks } from "../../config/locks.js";
import {
	readOptionalTextFile,
	writePrivateFile,
} from "../../shared/private-file.js";
import { resolveLaunchEntryPath } from "./launch-path.js";

export const ClientNameSchema = z.enum(["claude", "codex", "vscode", "cursor"]);
export type ClientName = z.infer<typeof ClientNameSchema>;
type JsonClientName = Exclude<ClientName, "codex">;

export const CLIENTS = {
	claude: {
		label: "Claude Desktop",
		instructions:
			"Open Claude Desktop Settings > Developer > Edit Config, merge this entry, then fully quit and reopen Claude Desktop.",
	},
	codex: {
		label: "Codex",
		instructions:
			"Merge this table into your Codex config.toml, then start a new Codex session.",
	},
	vscode: {
		label: "VS Code",
		instructions:
			"Run MCP: Open User Configuration in VS Code, merge this entry, then use MCP: List Servers to start or restart Proton Mail.",
	},
	cursor: {
		label: "Cursor",
		instructions:
			"Merge this entry into ~/.cursor/mcp.json, then restart the Proton Mail server from Cursor's MCP settings.",
	},
} satisfies Record<ClientName, { label: string; instructions: string }>;

const JsonObjectSchema = z.record(z.string(), z.json());

export function launchSpecification({
	configPath,
	entryPath,
	nodePath = process.execPath,
}: {
	configPath: string;
	entryPath: string;
	nodePath?: string;
}) {
	return {
		command: resolve(nodePath),
		args: [
			resolveLaunchEntryPath({ entryPath }),
			"serve",
			"--config",
			resolve(configPath),
		],
	};
}

export type LaunchSpecification = ReturnType<typeof launchSpecification>;

export type ClientInstallation = Awaited<
	ReturnType<typeof prepareClientInstallation>
>;

function serversKey(client: JsonClientName) {
	return client === "vscode" ? "servers" : "mcpServers";
}

function clientEntry(client: JsonClientName, launch: LaunchSpecification) {
	return client === "claude" ? launch : { type: "stdio", ...launch };
}

export function renderClientConfig(
	client: ClientName,
	launch: LaunchSpecification,
	serverName = "protonmail",
) {
	if (client === "codex")
		return stringifyToml({ mcp_servers: { [serverName]: launch } });
	const document = {
		[serversKey(client)]: { [serverName]: clientEntry(client, launch) },
	};
	return `${JSON.stringify(document, null, 2)}\n`;
}

export function defaultClientConfigPath(client: ClientName) {
	const home = homedir();
	switch (client) {
		case "claude":
			return defaultClaudeConfigPath(home);
		case "codex":
			return join(
				process.env.CODEX_HOME || join(home, ".codex"),
				"config.toml",
			);
		case "cursor":
			return join(home, ".cursor", "mcp.json");
		case "vscode":
			return null;
	}
}

function defaultClaudeConfigPath(home: string) {
	if (process.platform === "darwin")
		return join(
			home,
			"Library",
			"Application Support",
			"Claude",
			"claude_desktop_config.json",
		);
	if (process.platform === "win32")
		return join(
			process.env.APPDATA || join(home, "AppData", "Roaming"),
			"Claude",
			"claude_desktop_config.json",
		);
	return null;
}

export function mergeClientConfig(
	client: ClientName,
	contents: string,
	launch: LaunchSpecification,
	serverName = "protonmail",
) {
	if (client === "codex") return mergeCodexConfig(contents, launch, serverName);
	return mergeJsonConfig(client, contents, launch, serverName);
}

function mergeCodexConfig(
	contents: string,
	launch: LaunchSpecification,
	serverName: string,
) {
	const document = parseToml(contents);
	const existingServers = document.mcp_servers;
	if (existingServers !== undefined && !isTomlTable(existingServers))
		throw new Error("mcp_servers must be a TOML table.");
	return stringifyToml({
		...document,
		mcp_servers: { ...existingServers, [serverName]: launch },
	});
}

function isTomlTable(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		!(value instanceof Date)
	);
}

/** Edits the JSONC text in place so comments and unrelated formatting survive. */
function mergeJsonConfig(
	client: JsonClientName,
	contents: string,
	launch: LaunchSpecification,
	serverName: string,
) {
	const source = contents || "{}";
	const errors: ParseError[] = [];
	const parsed: unknown = parseJsonc(source, errors, {
		allowTrailingComma: true,
	});
	if (errors.length)
		throw new Error(
			"Client configuration contains invalid JSON. Fix it before installing the server entry.",
		);

	const document = JsonObjectSchema.parse(parsed);
	const key = serversKey(client);
	if (document[key] !== undefined) JsonObjectSchema.parse(document[key]);
	const edits = modify(source, [key, serverName], clientEntry(client, launch), {
		formattingOptions: { insertSpaces: true, tabSize: 2 },
	});
	return applyEdits(source, edits);
}

export async function prepareClientInstallation(
	client: ClientName,
	path: string,
	launch: LaunchSpecification,
	serverName = "protonmail",
) {
	const original = await readOptionalTextFile(path);
	const updated = mergeClientConfig(client, original ?? "", launch, serverName);
	return { client, path: resolve(path), original, updated };
}

/** Returns the backup path, or null when no previous file existed. */
export async function installClientConfig(plan: ClientInstallation) {
	return withSettingsLocks([plan.path], async () => {
		const current = await readOptionalTextFile(plan.path);
		if (current !== plan.original)
			throw new Error(
				"Client configuration changed while the installation was being reviewed. Generate a new preview before saving.",
			);

		let backup: string | null = null;
		if (current !== null) {
			backup = `${plan.path}.${randomUUID()}.bak`;
			await writePrivateFile(backup, current);
		}
		await writePrivateFile(plan.path, plan.updated);
		return backup;
	});
}

export function clientConfigSavedMessage(backup: string | null) {
	const backupNotice = backup ? ` Backup: ${backup}` : "";
	return `Client configuration saved.${backupNotice}`;
}
