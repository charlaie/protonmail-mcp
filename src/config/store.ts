import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { ConfigSchema } from "@/bridge/config.js";
import { isMissingFile, writePrivateFile } from "@/shared/private-file.js";
import { getConfigFilePath, getDefaultStorage } from "./paths.js";

export const ServerConfigSchema = z.strictObject({
	version: z.literal(1),
	bridge: ConfigSchema,
	storage: z
		.strictObject({
			policyFile: z.string().trim().min(1),
			operationsDirectory: z.string().trim().min(1),
		})
		.optional(),
});

export function resolveServerConfig(value: unknown, path: string) {
	const parsed = ServerConfigSchema.parse(value);
	const storage = parsed.storage
		? {
				policyFile: resolve(dirname(path), parsed.storage.policyFile),
				operationsDirectory: resolve(
					dirname(path),
					parsed.storage.operationsDirectory,
				),
			}
		: getDefaultStorage(path);
	if (storage.policyFile === resolve(path))
		throw new Error(
			"The server configuration and access policy must use separate files.",
		);
	return {
		...parsed,
		storage,
	};
}

export type ServerConfig = ReturnType<typeof resolveServerConfig>;

export async function readServerConfig(
	path = getConfigFilePath(),
): Promise<ServerConfig | null> {
	let contents: string;
	try {
		contents = await readFile(path, "utf8");
	} catch (error) {
		if (isMissingFile(error)) return null;
		throw error;
	}
	try {
		return resolveServerConfig(JSON.parse(contents), resolve(path));
	} catch {
		throw new Error(
			`Invalid configuration at ${resolve(path)}. Check its JSON structure and bridge settings, or run protonmail-mcp setup --config ${JSON.stringify(resolve(path))}.`,
		);
	}
}

export async function requireServerConfig(path = getConfigFilePath()) {
	const config = await readServerConfig(path);
	if (!config)
		throw new Error(
			`No configuration at ${resolve(path)}. Run protonmail-mcp setup --config ${JSON.stringify(resolve(path))} in a terminal. Credentials in .env files and PROTONMAIL_* environment variables are no longer loaded.`,
		);
	return config;
}

export async function saveServerConfig(
	config: ServerConfig,
	path = getConfigFilePath(),
) {
	const validated = resolveServerConfig(config, resolve(path));
	await writePrivateFile(path, `${JSON.stringify(validated, null, 2)}\n`);
}
