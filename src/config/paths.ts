import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export function getConfigDirectory() {
	if (process.platform === "win32")
		return join(
			process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
			"protonmail-mcp",
		);
	if (process.platform === "darwin")
		return join(homedir(), "Library", "Application Support", "protonmail-mcp");
	return join(
		process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
		"protonmail-mcp",
	);
}

export function getConfigFilePath() {
	return join(getConfigDirectory(), "config.json");
}

// Preserve the previous default policy and replay journal locations on every OS.
export function getDefaultPolicyFilePath() {
	return join(homedir(), ".config", "protonmail-mcp", "read-policy.json");
}

export function getDefaultStorage(configPath: string) {
	return {
		policyFile: defaultPolicyFileFor(configPath),
		// Journals are keyed by account. Sharing the directory retains replay
		// protection when multiple profiles use the same Bridge account.
		operationsDirectory: join(
			dirname(getDefaultPolicyFilePath()),
			"send-operations",
		),
	};
}

function defaultPolicyFileFor(configPath: string) {
	const absolutePath = resolve(configPath);
	if (absolutePath === resolve(getConfigFilePath()))
		return getDefaultPolicyFilePath();
	return join(dirname(absolutePath), `${basename(configPath)}.policy.json`);
}
