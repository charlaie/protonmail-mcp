import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function readOptionalTextFile(
	path: string,
): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (isMissingFile(error)) return null;
		throw error;
	}
}

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
		await replacePrivateFile(temporaryPath, path);
	} finally {
		await rm(temporaryPath, { force: true });
	}
}

export async function replacePrivateFile(source: string, destination: string) {
	// Windows readers and virus scanners can briefly prevent replacement. Keep
	// retrying the rename itself so readers always see a complete, private file.
	for (let attempt = 0; ; attempt++) {
		try {
			await rename(source, destination);
			return;
		} catch (error) {
			if (attempt >= 6 || !isWindowsReplacementError(error)) throw error;
			await delay(25 * 2 ** attempt);
		}
	}
}

function isWindowsReplacementError(error: unknown) {
	return (
		process.platform === "win32" &&
		error !== null &&
		typeof error === "object" &&
		"code" in error &&
		(error.code === "EPERM" ||
			error.code === "EACCES" ||
			error.code === "EBUSY")
	);
}

export function isMissingFile(error: unknown) {
	return (
		error !== null &&
		typeof error === "object" &&
		"code" in error &&
		error.code === "ENOENT"
	);
}
