import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { launchSpecification } from "./configuration.js";
import { resolveLaunchEntryPath } from "./launch-path.js";

const execute = promisify(execFile);

async function writePackage(directory: string, version: string) {
	const entry = join(directory, "build", "index.js");
	await mkdir(dirname(entry), { recursive: true });
	await writeFile(
		join(directory, "package.json"),
		JSON.stringify({ name: "protonmail-mcp", version, type: "module" }),
	);
	await writeFile(
		entry,
		`import { writeSync } from "node:fs"; writeSync(1, JSON.stringify({version: ${JSON.stringify(version)}, args: process.argv.slice(2)}));`,
	);
	return entry;
}

test("unchanged client configuration follows a package upgrade after removing the old version", async (t) => {
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), "protonmail-launch-upgrade-")),
	);
	t.after(() => rm(directory, { recursive: true, force: true }));
	const global = join(directory, "global", "5");
	const versionDirectory = (version: string) =>
		join(global, ".pnpm", `protonmail-mcp@${version}`);
	const firstDirectory = versionDirectory("1.0.0");
	const firstPackage = join(firstDirectory, "node_modules", "protonmail-mcp");
	const firstEntry = await writePackage(firstPackage, "1.0.0");
	const publicPackage = join(global, "node_modules", "protonmail-mcp");
	await mkdir(dirname(publicPackage), { recursive: true });
	await symlink(firstPackage, publicPackage, "junction");
	const configPath = join(directory, "account & %! ' (work).json");
	const launch = launchSpecification({ configPath, entryPath: firstEntry });
	assert.equal(launch.args[0], join(publicPackage, "build", "index.js"));
	assert.equal(launch.command, process.execPath);
	const run = async () => {
		const { stdout } = await execute(launch.command, launch.args, {
			cwd: tmpdir(),
			env: { ...process.env, PATH: "" },
			encoding: "utf8",
		});
		return stdout.trim();
	};
	assert.equal(
		await run(),
		JSON.stringify({
			version: "1.0.0",
			args: ["serve", "--config", configPath],
		}),
	);
	const secondPackage = join(
		versionDirectory("1.0.1"),
		"node_modules",
		"protonmail-mcp",
	);
	const secondEntry = await writePackage(secondPackage, "1.0.1");
	await rm(publicPackage);
	await symlink(secondPackage, publicPackage, "junction");
	await rm(firstDirectory, { recursive: true });
	assert.equal(
		await run(),
		JSON.stringify({
			version: "1.0.1",
			args: ["serve", "--config", configPath],
		}),
	);
	assert.deepEqual(
		launchSpecification({ configPath, entryPath: secondEntry }),
		launch,
	);
});

test("npm-style package entries and source checkouts keep working without shell wrappers", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "protonmail-launch-layouts-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	// Resolve the temporary directory itself for systems where tmpdir is a symlink.
	const root = await realpath(directory);
	for (const packageDirectory of [
		join(root, "prefix", "lib", "node_modules", "protonmail-mcp"),
		join(root, "windows-prefix", "node_modules", "protonmail-mcp"),
		join(root, "checkout"),
		join(root, "dlx", "checkout"),
		join(root, "dlx", "node_modules", "protonmail-mcp"),
		join(root, "_npx", "node_modules", "protonmail-mcp"),
		join(root, ".pnpm", "node_modules", "protonmail-mcp"),
	]) {
		const entry = await writePackage(packageDirectory, "1.0.0");
		assert.equal(resolveLaunchEntryPath({ entryPath: entry }), entry);
	}
});

test("only links to the running installation can replace its entry path", async (t) => {
	const directory = await mkdtemp(
		join(tmpdir(), "protonmail-launch-identity-"),
	);
	t.after(() => rm(directory, { recursive: true, force: true }));
	const source = await writePackage(join(directory, "checkout"), "1.0.0");
	await writePackage(
		join(directory, "node_modules", "protonmail-mcp"),
		"2.0.0",
	);
	assert.equal(resolveLaunchEntryPath({ entryPath: source }), source);
	const linkedSource = join(directory, "linked checkout");
	await symlink(dirname(dirname(source)), linkedSource, "junction");
	const invoked = join(linkedSource, "build", "index.js");
	assert.equal(resolveLaunchEntryPath({ entryPath: invoked }), invoked);
});

test("temporary and unsupported layouts retain a direct launch for diagnostics", async (t) => {
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), "protonmail-launch-cache-")),
	);
	t.after(() => rm(directory, { recursive: true, force: true }));
	for (const packageDirectory of [
		join(
			directory,
			".pnpm",
			"protonmail-mcp@1.0.0",
			"node_modules",
			"protonmail-mcp",
		),
		join(directory, "cache", "_npx", "hash", "node_modules", "protonmail-mcp"),
		join(directory, "cache", "dlx", "hash", "node_modules", "protonmail-mcp"),
	]) {
		const entry = await writePackage(packageDirectory, "1.0.0");
		assert.equal(resolveLaunchEntryPath({ entryPath: entry }), entry);
	}
});

test("an unrelated non-directory candidate cannot break a source launch", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "protonmail-launch-probes-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const entry = await writePackage(join(directory, "checkout"), "1.0.0");
	await writeFile(join(directory, "node_modules"), "unrelated file");
	assert.equal(resolveLaunchEntryPath({ entryPath: entry }), entry);
	const missing = join(directory, "missing", "build", "index.js");
	assert.equal(resolveLaunchEntryPath({ entryPath: missing }), missing);
});
