import { readFile } from "node:fs/promises";
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
import { isMissingFile, writePrivateFile } from "../shared/private-file.js";
import { resolveLaunchEntryPath } from "./launch-path.js";

export const ClientNameSchema = z.enum(["claude", "codex", "vscode", "cursor"]);
export type ClientName = z.infer<typeof ClientNameSchema>;

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

function clientEntry(client: ClientName, launch: LaunchSpecification) {
	return client === "vscode" || client === "cursor"
		? { type: "stdio", ...launch }
		: launch;
}

export function renderClientConfig(
	client: ClientName,
	launch: LaunchSpecification,
	serverName = "protonmail",
) {
	if (client === "codex")
		return stringifyToml({ mcp_servers: { [serverName]: launch } });
	return `${JSON.stringify({ [client === "vscode" ? "servers" : "mcpServers"]: { [serverName]: clientEntry(client, launch) } }, null, 2)}\n`;
}

export function defaultClientConfigPath(client: ClientName) {
	const home = homedir();
	switch (client) {
		case "claude":
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

const JsonDocumentSchema = z.record(z.string(), z.json());
const JsonObjectSchema = z.record(z.string(), z.json());

export function mergeClientConfig(
	client: ClientName,
	contents: string,
	launch: LaunchSpecification,
	serverName = "protonmail",
) {
	if (client === "codex") {
		const document = parseToml(contents);
		const existingServers = document.mcp_servers;
		if (
			existingServers !== undefined &&
			(typeof existingServers !== "object" ||
				existingServers === null ||
				Array.isArray(existingServers) ||
				existingServers instanceof Date)
		)
			throw new Error("mcp_servers must be a TOML table.");
		return stringifyToml({
			...document,
			mcp_servers: { ...existingServers, [serverName]: launch },
		});
	}
	const errors: ParseError[] = [];
	const parsed: unknown = parseJsonc(contents || "{}", errors, {
		allowTrailingComma: true,
	});
	if (errors.length)
		throw new Error(
			"Client configuration contains invalid JSON. Fix it before installing the server entry.",
		);
	const document = JsonDocumentSchema.parse(parsed);
	const key = client === "vscode" ? "servers" : "mcpServers";
	if (document[key] !== undefined) JsonObjectSchema.parse(document[key]);
	return applyEdits(
		contents || "{}",
		modify(contents || "{}", [key, serverName], clientEntry(client, launch), {
			formattingOptions: { insertSpaces: true, tabSize: 2 },
		}),
	);
}

export async function prepareClientInstallation(
	client: ClientName,
	path: string,
	launch: LaunchSpecification,
	serverName = "protonmail",
) {
	let original: string | null;
	try {
		original = await readFile(path, "utf8");
	} catch (error) {
		if (!isMissingFile(error)) throw error;
		original = null;
	}
	const updated = mergeClientConfig(client, original ?? "", launch, serverName);
	return { client, path: resolve(path), original, updated };
}

export async function installClientConfig(
	plan: Awaited<ReturnType<typeof prepareClientInstallation>>,
) {
	let current: string | null;
	try {
		current = await readFile(plan.path, "utf8");
	} catch (error) {
		if (!isMissingFile(error)) throw error;
		current = null;
	}
	if (current !== plan.original)
		throw new Error(
			"Client configuration changed while the installation was being reviewed. Generate a new preview before saving.",
		);
	let backup: string | null = null;
	if (current !== null) {
		backup = `${plan.path}.${Date.now()}.bak`;
		await writePrivateFile(backup, current);
	}
	await writePrivateFile(plan.path, plan.updated);
	return backup;
}
