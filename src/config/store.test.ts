import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { testConfig } from "@/bridge/testing/fixtures.js";
import {
	getConfigDirectory,
	getConfigFilePath,
	getDefaultPolicyFilePath,
} from "./paths.js";
import {
	readServerConfig,
	requireServerConfig,
	resolveServerConfig,
	saveServerConfig,
} from "./store.js";

test("additional profiles get distinct policies and share account-keyed replay journals", () => {
	const value = { version: 1, bridge: testConfig };
	const personal = resolveServerConfig(
		value,
		join(tmpdir(), "accounts", "personal.json"),
	);
	const work = resolveServerConfig(
		value,
		join(tmpdir(), "accounts", "work.json"),
	);
	const standard = resolveServerConfig(value, getConfigFilePath());
	assert.notEqual(personal.storage.policyFile, work.storage.policyFile);
	assert.equal(
		personal.storage.policyFile,
		join(tmpdir(), "accounts", "personal.json.policy.json"),
	);
	assert.equal(standard.storage.policyFile, getDefaultPolicyFilePath());
	assert.equal(
		standard.storage.policyFile,
		join(getConfigDirectory(), "read-policy.json"),
	);
	assert.equal(
		standard.storage.operationsDirectory,
		join(getConfigDirectory(), "send-operations"),
	);
	assert.equal(
		personal.storage.operationsDirectory,
		standard.storage.operationsDirectory,
	);
	assert.equal(
		work.storage.operationsDirectory,
		standard.storage.operationsDirectory,
	);
	assert.throws(
		() =>
			resolveServerConfig(
				{
					...value,
					storage: {
						policyFile: "personal.json",
						operationsDirectory: "journal",
					},
				},
				join(tmpdir(), "accounts", "personal.json"),
			),
		/separate files/,
	);
});

test("JSON configuration has private atomic persistence and resolves paths beside the file", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "protonmail-config-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "config.json");
	const config = resolveServerConfig(
		{
			version: 1,
			bridge: testConfig,
			storage: { policyFile: "access.json", operationsDirectory: "journal" },
		},
		path,
	);
	assert.equal(config.storage.policyFile, join(directory, "access.json"));
	assert.equal(config.storage.operationsDirectory, join(directory, "journal"));
	await saveServerConfig(config, path);
	if (process.platform !== "win32")
		assert.equal((await stat(path)).mode & 0o777, 0o600);
	assert.deepEqual(await requireServerConfig(path), config);
	const contents = await readFile(path, "utf8");
	await assert.rejects(
		saveServerConfig(
			{ ...config, bridge: { ...config.bridge, password: "" } },
			path,
		),
	);
	assert.equal(await readFile(path, "utf8"), contents);
});

test("missing or invalid config gives repair instructions without disclosing credential values", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "protonmail-config-errors-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "config.json");
	assert.equal(await readServerConfig(path), null);
	await writeFile(
		join(directory, ".env"),
		"PROTONMAIL_BRIDGE_USER=ignored@example.com\nPROTONMAIL_BRIDGE_PASSWORD=ignored-secret\n",
	);
	await assert.rejects(requireServerConfig(path), /setup.*--config/);
	await writeFile(
		path,
		JSON.stringify({
			version: 1,
			bridge: { user: "me", password: "secret-value", host: "remote.example" },
		}),
	);
	await assert.rejects(requireServerConfig(path), (error: unknown) => {
		assert.ok(error instanceof Error);
		assert.match(error.message, /Invalid configuration/);
		assert.ok(!error.message.includes("secret-value"));
		return true;
	});
});
