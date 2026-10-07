import { randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { safeErrorMessage } from "../shared/errors.js";

import type { ReadPolicy } from "./schema.js";
import { ReadPolicySchema } from "./schema.js";

export function getPolicyFilePath() {
	return (
		process.env.PROTONMAIL_MCP_POLICY_FILE?.trim() ||
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

		throw new Error(
			`Unable to load read policy at ${path}: ${safeErrorMessage(error)}. Run protonmail-mcp setup to replace it or reset-policy to remove it.`,
			{ cause: error },
		);
	}
}

export async function saveReadPolicy(policy: ReadPolicy) {
	const validated = ReadPolicySchema.parse(policy);
	const path = getPolicyFilePath();
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${randomUUID()}.tmp`;
	try {
		const file = await open(temporaryPath, "wx", 0o600);
		try {
			await file.writeFile(`${JSON.stringify(validated, null, 2)}\n`);
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporaryPath, path);
	} finally {
		await rm(temporaryPath, { force: true });
	}
}

export async function hasReadPolicyFile() {
	try {
		await access(getPolicyFilePath());
		return true;
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "ENOENT"
		)
			return false;
		throw error;
	}
}

export async function resetReadPolicy() {
	const path = getPolicyFilePath();
	await rm(path, { force: true });
}
