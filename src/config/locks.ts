import { mkdir, open, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/** Hold every reviewed path until its update and any rollback have finished. */
export async function withSettingsLocks<T>(
	paths: readonly string[],
	update: () => Promise<T>,
): Promise<T> {
	const lockOrder = [...new Set(paths.map((path) => resolve(path)))].sort();
	const acquired: string[] = [];
	try {
		for (const path of lockOrder) {
			await mkdir(dirname(path), { recursive: true, mode: 0o700 });
			await acquireLock(`${path}.setup.lock`, acquired);
		}
		return await update();
	} finally {
		await Promise.all(
			acquired.map((lockPath) => rm(lockPath, { force: true })),
		);
	}
}

/** Records the lock before closing it so a failed close still releases the file. */
async function acquireLock(lockPath: string, acquired: string[]) {
	try {
		const lock = await open(lockPath, "wx", 0o600);
		acquired.push(lockPath);
		await lock.close();
	} catch (error) {
		throw new Error(
			`Cannot lock settings at ${lockPath}. Another setup may be running; remove a stale lock only after confirming it has stopped.`,
			{ cause: error },
		);
	}
}
