import { readFileSync } from "node:fs";
import { access, readFile, rm } from "node:fs/promises";
import { getDefaultPolicyFilePath } from "../config/paths.js";
import { safeErrorMessage } from "../shared/errors.js";
import { isMissingFile, writePrivateFile } from "../shared/private-file.js";
import { type ReadPolicy, ReadPolicySchema } from "./schema.js";

export const getPolicyFilePath = getDefaultPolicyFilePath;

function parseReadPolicy(contents: string): ReadPolicy {
	return ReadPolicySchema.parse(JSON.parse(contents));
}

// A missing file means no policy; any other read or validation failure fails closed.
function missingPolicyOrThrow(error: unknown, path: string): null {
	if (isMissingFile(error)) return null;
	throw new Error(
		`Unable to load read policy at ${path}: ${safeErrorMessage(error)}. Run protonmail-mcp setup to replace it or reset-policy to remove it.`,
		{ cause: error },
	);
}

export function loadReadPolicySync(
	path = getPolicyFilePath(),
): ReadPolicy | null {
	try {
		return parseReadPolicy(readFileSync(path, "utf8"));
	} catch (error) {
		return missingPolicyOrThrow(error, path);
	}
}

export async function loadReadPolicy(
	path = getPolicyFilePath(),
): Promise<ReadPolicy | null> {
	try {
		return parseReadPolicy(await readFile(path, "utf8"));
	} catch (error) {
		return missingPolicyOrThrow(error, path);
	}
}

export async function saveReadPolicy(
	policy: ReadPolicy,
	path = getPolicyFilePath(),
) {
	const validated = ReadPolicySchema.parse(policy);
	await writePrivateFile(path, `${JSON.stringify(validated, null, 2)}\n`);
}

export async function hasReadPolicyFile(path = getPolicyFilePath()) {
	try {
		await access(path);
		return true;
	} catch (error) {
		if (isMissingFile(error)) return false;
		throw error;
	}
}

export async function resetReadPolicy(path = getPolicyFilePath()) {
	await rm(path, { force: true });
}
