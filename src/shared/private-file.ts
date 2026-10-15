import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

export async function stagePrivateFile(path: string, contents: string) {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporaryPath = `${path}.${randomUUID()}.tmp`;
	try {
		const file = await open(temporaryPath, "wx", 0o600);
		try {
			await file.writeFile(contents);
			await file.sync();
		} finally {
			await file.close();
		}
		return temporaryPath;
	} catch (error) {
		await rm(temporaryPath, { force: true });
		throw error;
	}
}

export async function writePrivateFile(path: string, contents: string) {
	const temporaryPath = await stagePrivateFile(path, contents);
	try {
		await rename(temporaryPath, path);
	} finally {
		await rm(temporaryPath, { force: true });
	}
}

export function isMissingFile(error: unknown) {
	return (
		error !== null &&
		typeof error === "object" &&
		"code" in error &&
		error.code === "ENOENT"
	);
}
