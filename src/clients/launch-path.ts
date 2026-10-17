import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function realPathIfAccessible(path: string) {
	try {
		return realpathSync(path);
	} catch {
		// Optional link discovery must not prevent launching the original entry.
		return null;
	}
}

/** Preserve the public package link rather than pinning a package-store version. */
export function resolveLaunchEntryPath({ entryPath }: { entryPath: string }) {
	const entry = resolve(entryPath);
	const actual = realPathIfAccessible(entry);
	if (!actual) return entry;
	let selected = entry;
	// PNPM's public node_modules link follows upgrades, while its .pnpm entry
	// contains the version. npm's global node_modules entry is already stable.
	let directory = dirname(actual);
	while (true) {
		const candidate = join(
			directory,
			"node_modules",
			"protonmail-mcp",
			"build",
			"index.js",
		);
		if (realPathIfAccessible(candidate) === actual) selected = candidate;
		const parent = dirname(directory);
		if (parent === directory) return selected;
		directory = parent;
	}
}
