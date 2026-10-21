import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { ConfigSchema } from "../bridge/config.js";
import { isMissingFile, writePrivateFile } from "../shared/private-file.js";
import { getConfigFilePath, getDefaultStorage } from "./paths.js";

const StorageSchema = z.strictObject({
	policyFile: z.string().trim().min(1),
	operationsDirectory: z.string().trim().min(1),
});

export const ServerConfigSchema = z.strictObject({
	version: z.literal(1),
	bridge: ConfigSchema,
	storage: StorageSchema.optional(),
});

/** Relative storage paths resolve beside the configuration file. */
function resolveStorage(
	storage: z.infer<typeof StorageSchema> | undefined,
	configPath: string,
) {
	if (!storage) return getDefaultStorage(configPath);
	const directory = dirname(configPath);
	return {
		policyFile: resolve(directory, storage.policyFile),
		operationsDirectory: resolve(directory, storage.operationsDirectory),
	};
}

export function resolveServerConfig(value: unknown, path: string) {
	const parsed = ServerConfigSchema.parse(value);
	const storage = resolveStorage(parsed.storage, path);
	if (storage.policyFile === resolve(path))
		throw new Error(
			"The server configuration and access policy must use separate files.",
		);
	return { ...parsed, storage };
}

export type ServerConfig = ReturnType<typeof resolveServerConfig>;

export async function readServerConfig(
	path = getConfigFilePath(),
): Promise<ServerConfig | null> {
	const absolutePath = resolve(path);
	let contents: string;
	try {
		contents = await readFile(path, "utf8");
	} catch (error) {
		if (isMissingFile(error)) return null;
		throw error;
	}

	try {
		return resolveServerConfig(JSON.parse(contents), absolutePath);
	} catch {
		throw new Error(
			`Invalid configuration at ${absolutePath}. Check its JSON structure and bridge settings, or run protonmail-mcp setup --config ${JSON.stringify(absolutePath)}.`,
		);
	}
}

export async function requireServerConfig(path = getConfigFilePath()) {
	const config = await readServerConfig(path);
	if (!config) {
		const absolutePath = resolve(path);
		throw new Error(
			`No configuration at ${absolutePath}. Run protonmail-mcp setup --config ${JSON.stringify(absolutePath)} in a terminal. Credentials in .env files and PROTONMAIL_* environment variables are no longer loaded.`,
		);
	}
	return config;
}

export async function saveServerConfig(
	config: ServerConfig,
	path = getConfigFilePath(),
) {
	const validated = resolveServerConfig(config, resolve(path));
	await writePrivateFile(path, `${JSON.stringify(validated, null, 2)}\n`);
}
