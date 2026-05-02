import { readFile } from "node:fs/promises";

export async function loadDotEnv(path = ".env") {
	try {
		const contents = await readFile(path, "utf8");

		for (const line of contents.split(/\r?\n/)) {
			const trimmed = line.trim();

			if (!trimmed || trimmed.startsWith("#")) {
				continue;
			}

			const separator = trimmed.indexOf("=");

			if (separator === -1) {
				continue;
			}

			const key = trimmed.slice(0, separator).trim();
			const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");

			if (key && process.env[key] === undefined) {
				process.env[key] = value;
			}
		}
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "ENOENT"
		) {
			return;
		}

		throw error;
	}
}
