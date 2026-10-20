import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createImapService } from "../../bridge/imap/service.js";
import { FakeImap, testConfig } from "../../bridge/testing/fixtures.js";
import { resolveServerConfig } from "../../config/store.js";
import { createReadPolicy } from "../../policy/schema.js";
import { saveReadPolicy } from "../../policy/store.js";
import { launchSpecification } from "../clients/configuration.js";
import { connectionFailureMessage, diagnoseServer } from "./service.js";

test("doctor authenticates without mail mutations and reports client UI as unverified", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "protonmail-doctor-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const config = resolveServerConfig(
		{
			version: 1,
			bridge: testConfig,
			storage: { policyFile: "policy.json", operationsDirectory: "journal" },
		},
		join(directory, "config.json"),
	);
	await saveReadPolicy(
		createReadPolicy({
			bridgeUser: testConfig.user,
			allowedMailboxes: ["INBOX"],
		}),
		config.storage.policyFile,
	);
	const imap = new FakeImap();
	let smtpChecks = 0;
	const results = await diagnoseServer(
		config,
		launchSpecification({ configPath: "config.json", entryPath: "index.js" }),
		{
			imap: createImapService(testConfig, async (operation) => operation(imap)),
			verifySmtp: async () => {
				smtpChecks++;
			},
			checkMcp: async () => "Fixture handshake passed.",
		},
	);
	assert.equal(
		results.filter((result) => result.status === "failed").length,
		0,
	);
	assert.equal(results.at(-1)?.status, "unverified");
	assert.equal(smtpChecks, 1);
	assert.equal(imap.appends.length, 0);
	assert.equal(imap.deletions, 0);
});

test("doctor reports independent failures with fixes and redacts credentials", async (t) => {
	const directory = await mkdtemp(
		join(tmpdir(), "protonmail-doctor-failures-"),
	);
	t.after(() => rm(directory, { recursive: true, force: true }));
	const config = resolveServerConfig(
		{
			version: 1,
			bridge: testConfig,
			storage: { policyFile: "missing.json", operationsDirectory: "journal" },
		},
		join(directory, "config.json"),
	);
	const results = await diagnoseServer(
		config,
		launchSpecification({ configPath: "config.json", entryPath: "index.js" }),
		{
			imap: {
				listMailboxes: async () => {
					throw new Error("connect ECONNREFUSED");
				},
			},
			verifySmtp: async () => {
				throw new Error(`authentication failed for ${testConfig.password}`);
			},
			checkMcp: async () => {
				throw new Error("Handshake failed.");
			},
		},
	);
	assert.deepEqual(
		results
			.filter((result) => result.status === "failed")
			.map((result) => result.check),
		["imap", "smtp", "permissions", "mcp"],
	);
	assert.ok(!JSON.stringify(results).includes(testConfig.password));
	assert.equal(
		connectionFailureMessage(
			new Error(`Unexpected ${testConfig.password}`),
			testConfig.password,
		),
		"Unexpected [redacted]",
	);
});
