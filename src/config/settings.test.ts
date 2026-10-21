import { strict as assert } from "node:assert";
import { mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { testConfig } from "../bridge/testing/fixtures.js";
import { createReadPolicy } from "../policy/schema.js";
import { saveReadPolicy } from "../policy/store.js";
import { readOptionalTextFile } from "../shared/private-file.js";
import { commitSettings } from "./settings.js";
import { resolveServerConfig, saveServerConfig } from "./store.js";

async function fixture(t: TestContext, existing = true) {
	const directory = await mkdtemp(join(tmpdir(), "protonmail-settings-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const configPath = join(directory, "config.json");
	const config = resolveServerConfig(
		{
			version: 1,
			bridge: testConfig,
			storage: { policyFile: "policy.json", operationsDirectory: "journal" },
		},
		configPath,
	);
	const policy = createReadPolicy({
		bridgeUser: testConfig.user,
		allowedMailboxes: ["INBOX"],
	});
	if (existing) {
		await saveServerConfig(config, configPath);
		await saveReadPolicy(policy, config.storage.policyFile);
	}
	const expectedConfig = await readOptionalTextFile(configPath);
	const expectedPolicy = await readOptionalTextFile(config.storage.policyFile);
	const input = {
		configPath,
		config,
		policy: { ...policy, allowedTools: [] },
		expectedConfig,
		expectedPolicy,
	};
	return { directory, input };
}

for (const existing of [true, false]) {
	test(`failed configuration replacement restores ${existing ? "existing" : "missing"} policy and removes staged files`, async (t) => {
		const { directory, input } = await fixture(t, existing);
		await assert.rejects(
			commitSettings(input, async (source, destination) => {
				if (destination === input.configPath)
					throw new Error("Simulated config replacement failure");
				await rename(source, destination);
			}),
			/Simulated/,
		);
		assert.equal(
			await readOptionalTextFile(input.configPath),
			input.expectedConfig,
		);
		assert.equal(
			await readOptionalTextFile(input.config.storage.policyFile),
			input.expectedPolicy,
		);
		assert.deepEqual(
			(await readdir(directory)).sort(),
			existing ? ["config.json", "policy.json"] : [],
		);
	});
}

test("a settings review cannot overwrite newer grants or another account's policy", async (t) => {
	const { input } = await fixture(t);
	const other = createReadPolicy({
		bridgeUser: "other@example.com",
		allowedMailboxes: ["Drafts"],
	});
	await saveReadPolicy(other, input.config.storage.policyFile);
	const changed = await readOptionalTextFile(input.config.storage.policyFile);
	await assert.rejects(commitSettings(input), /changed during setup/);
	await assert.rejects(
		commitSettings({ ...input, expectedPolicy: changed }),
		/another Bridge account/,
	);
	assert.equal(
		await readOptionalTextFile(input.config.storage.policyFile),
		changed,
	);
	assert.equal(
		await readOptionalTextFile(input.configPath),
		input.expectedConfig,
	);
});

test("concurrent commits sharing a policy cannot interleave", async (t) => {
	const { input } = await fixture(t);
	let release = () => {};
	let signal = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const paused = new Promise<void>((resolve) => {
		signal = resolve;
	});
	const first = commitSettings(input, async (source, destination) => {
		if (destination === input.config.storage.policyFile) {
			signal();
			await gate;
		}
		await rename(source, destination);
	});
	await paused;
	try {
		await assert.rejects(commitSettings(input), /Cannot lock settings/);
	} finally {
		release();
	}
	await first;
	await assert.rejects(commitSettings(input), /changed during setup/);
});
