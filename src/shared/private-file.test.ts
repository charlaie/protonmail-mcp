import { strict as assert } from "node:assert";
import fs, {
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { writePrivateFile } from "./private-file.js";

const nativeRename = rename;
const nativePlatform = process.platform;

async function fixture(t: TestContext, platform: NodeJS.Platform) {
	const directory = await mkdtemp(join(tmpdir(), "protonmail-private-file-"));
	const path = join(directory, "policy.json");
	await writeFile(path, "previous policy");
	const platformDescriptor = Object.getOwnPropertyDescriptor(
		process,
		"platform",
	);
	assert.ok(platformDescriptor);
	Object.defineProperty(process, "platform", { value: platform });
	t.after(async () => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
		Object.defineProperty(process, "platform", platformDescriptor);
		await rm(directory, { recursive: true, force: true });
	});
	return { directory, path };
}

for (const code of ["EPERM", "EACCES", "EBUSY"]) {
	test(`Windows replacement recovers from transient ${code} without removing the existing file`, async (t) => {
		const { directory, path } = await fixture(t, "win32");
		let attempts = 0;
		const replacement = t.mock.method(
			fs,
			"rename",
			async (...[source, destination]: Parameters<typeof rename>) => {
				assert.equal(await readFile(path, "utf8"), "previous policy");
				assert.equal(await readFile(source, "utf8"), "new policy");
				if (nativePlatform !== "win32")
					assert.equal((await stat(source)).mode & 0o777, 0o600);
				if (++attempts <= 2)
					throw Object.assign(new Error("file busy"), { code });
				await nativeRename(source, destination);
			},
		);
		syncBuiltinESMExports();
		await writePrivateFile(path, "new policy");
		assert.equal(replacement.mock.callCount(), 3);
		assert.equal(await readFile(path, "utf8"), "new policy");
		assert.deepEqual(await readdir(directory), ["policy.json"]);
	});
}

for (const { platform, code } of [
	{ platform: "win32", code: "EPERM" },
	{ platform: "win32", code: "ENOENT" },
	{ platform: "linux", code: "EPERM" },
] satisfies { platform: NodeJS.Platform; code: string }[]) {
	test(`${platform} replacement failure ${code} preserves the existing file and cleans up staging`, async (t) => {
		const { directory, path } = await fixture(t, platform);
		const failure = Object.assign(new Error("replacement failed"), { code });
		const replacement = t.mock.method(fs, "rename", async () => {
			throw failure;
		});
		syncBuiltinESMExports();
		await assert.rejects(
			writePrivateFile(path, "new policy"),
			(error: unknown) => error === failure,
		);
		assert.equal(
			replacement.mock.callCount(),
			platform === "win32" && code === "EPERM" ? 7 : 1,
		);
		assert.equal(await readFile(path, "utf8"), "previous policy");
		assert.deepEqual(await readdir(directory), ["policy.json"]);
	});
}
