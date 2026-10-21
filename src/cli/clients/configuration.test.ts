import { strict as assert } from "node:assert";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseJsonc } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { withSettingsLocks } from "@/config/locks.js";
import {
	ClientNameSchema,
	installClientConfig,
	launchSpecification,
	mergeClientConfig,
	prepareClientInstallation,
	renderClientConfig,
} from "./configuration.js";

test("each client receives its native format with absolute paths and no credential environment", () => {
	const launch = launchSpecification({
		configPath: "account config.json",
		entryPath: "build/index.js",
	});
	for (const client of ClientNameSchema.options) {
		const snippet = renderClientConfig(client, launch, "personal_mail");
		const document =
			client === "codex" ? parseToml(snippet) : JSON.parse(snippet);
		const entry =
			client === "codex"
				? document.mcp_servers.personal_mail
				: document[client === "vscode" ? "servers" : "mcpServers"]
						.personal_mail;
		assert.equal(entry.command, process.execPath);
		assert.deepEqual(entry.args, launch.args);
		assert.equal(entry.env, undefined);
	}
});

test("JSONC merges keep comments and other servers; TOML merges keep unrelated settings", () => {
	const launch = launchSpecification({
		configPath: "config.json",
		entryPath: "build/index.js",
	});
	const json =
		'{\n// keep this comment\n"servers": {"other": {"command": "other-tool"}}, "inputs": []\n}';
	const merged = mergeClientConfig("vscode", json, launch);
	assert.ok(merged.includes("// keep this comment"));
	assert.equal(parseJsonc(merged).servers.other.command, "other-tool");
	assert.deepEqual(parseJsonc(merged).inputs, []);
	const toml =
		'model = "user-selected-model"\n[mcp_servers.other]\ncommand = "other-tool"\n';
	const parsed = parseToml(mergeClientConfig("codex", toml, launch));
	assert.equal(parsed.model, "user-selected-model");
	assert.deepEqual(
		z
			.object({
				other: z.object({ command: z.string() }),
				protonmail: z.object({
					command: z.string(),
					args: z.array(z.string()),
				}),
			})
			.parse(parsed.mcp_servers),
		{
			other: { command: "other-tool" },
			protonmail: launch,
		},
	);
	assert.throws(() => mergeClientConfig("cursor", '{"mcpServers":[]}', launch));
	assert.throws(() =>
		mergeClientConfig("codex", 'mcp_servers = "broken"', launch),
	);
});

test("installation backs up originals and refuses changes made after review", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "protonmail-client-install-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "mcp.json");
	const original = '{"mcpServers":{"other":{"command":"other-tool"}}}';
	await writeFile(path, original);
	const plan = await prepareClientInstallation(
		"cursor",
		path,
		launchSpecification({ configPath: "config.json", entryPath: "index.js" }),
	);
	const backup = await installClientConfig(plan);
	assert.ok(backup);
	assert.equal(await readFile(backup, "utf8"), original);
	assert.equal(
		JSON.parse(await readFile(path, "utf8")).mcpServers.other.command,
		"other-tool",
	);
	await assert.rejects(installClientConfig(plan), /changed/);
});

test("client installation holds the settings lock across snapshot validation and replacement", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "protonmail-client-lock-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "mcp.json");
	const original = "{}";
	await writeFile(path, original);
	const launch = launchSpecification({
		configPath: "config.json",
		entryPath: "index.js",
	});
	const first = await prepareClientInstallation(
		"cursor",
		path,
		launch,
		"first",
	);
	const second = await prepareClientInstallation(
		"cursor",
		path,
		launch,
		"second",
	);
	await withSettingsLocks([path], async () => {
		await assert.rejects(installClientConfig(first), /Cannot lock settings/);
		assert.equal(await readFile(path, "utf8"), original);
		assert.deepEqual((await readdir(directory)).sort(), [
			"mcp.json",
			"mcp.json.setup.lock",
		]);
	});
	const results = await Promise.allSettled([
		installClientConfig(first),
		installClientConfig(second),
	]);
	assert.equal(
		results.filter((result) => result.status === "fulfilled").length,
		1,
	);
	assert.equal(
		results.filter((result) => result.status === "rejected").length,
		1,
	);
	const contents = await readFile(path, "utf8");
	assert.ok(contents === first.updated || contents === second.updated);
	const files = await readdir(directory);
	const backups = files.filter((file) => file.endsWith(".bak"));
	assert.equal(backups.length, 1);
	const [backup] = backups;
	assert.ok(backup);
	assert.equal(await readFile(join(directory, backup), "utf8"), original);
	assert.equal(
		files.some((file) => file.endsWith(".setup.lock")),
		false,
	);
});

test("successive installations keep distinct backups even within one clock tick", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "protonmail-client-backups-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "mcp.json");
	await writeFile(path, "{}");
	t.mock.method(Date, "now", () => 1234);
	const launch = launchSpecification({
		configPath: "config.json",
		entryPath: "index.js",
	});
	const first = await prepareClientInstallation(
		"cursor",
		path,
		launch,
		"first",
	);
	const firstBackup = await installClientConfig(first);
	const second = await prepareClientInstallation(
		"cursor",
		path,
		launch,
		"second",
	);
	const secondBackup = await installClientConfig(second);
	assert.ok(firstBackup);
	assert.ok(secondBackup);
	assert.notEqual(firstBackup, secondBackup);
	assert.equal(await readFile(firstBackup, "utf8"), "{}");
	assert.equal(await readFile(secondBackup, "utf8"), first.updated);
});
