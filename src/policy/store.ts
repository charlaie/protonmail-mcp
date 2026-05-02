import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ReadPolicy } from "./schema.js";
import { ReadPolicySchema } from "./schema.js";

export function getPolicyFilePath() {
	return (
		process.env.PROTONMAIL_MCP_POLICY_FILE ??
		join(homedir(), ".config", "protonmail-mcp", "read-policy.json")
	);
}

export async function loadReadPolicy(): Promise<ReadPolicy | null> {
	const path = getPolicyFilePath();

	try {
		const contents = await readFile(path, "utf8");
		return ReadPolicySchema.parse(JSON.parse(contents));
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "ENOENT"
		) {
			return null;
		}

		throw error;
	}
}

export async function saveReadPolicy(policy: ReadPolicy) {
	const path = getPolicyFilePath();
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(policy, null, 2)}\n`, {
		mode: 0o600,
	});
}

export async function resetReadPolicy() {
	const path = getPolicyFilePath();
	await rm(path, { force: true });
}
