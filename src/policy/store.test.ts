import { strict as assert } from "node:assert";
import {
	chmod,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createImapService } from "../bridge/imap.js";
import { FakeImap, testConfig } from "../bridge/test-fixtures.js";
import { createReadPolicy } from "./schema.js";
import {
	parseMailboxSelection,
	parseSenderDomains,
	parseSenderEmails,
} from "./selection.js";
import { createReadService } from "./service.js";
import {
	getPolicyFilePath,
	hasReadPolicyFile,
	loadReadPolicy,
	resetReadPolicy,
	saveReadPolicy,
} from "./store.js";

test("policy persistence stays complete and private; legacy/account mismatch is denied", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "protonmail-policy-"));
	const path = join(directory, "policy.json");
	const originalPath = process.env.PROTONMAIL_MCP_POLICY_FILE;
	process.env.PROTONMAIL_MCP_POLICY_FILE = path;
	t.after(async () => {
		if (originalPath === undefined)
			delete process.env.PROTONMAIL_MCP_POLICY_FILE;
		else process.env.PROTONMAIL_MCP_POLICY_FILE = originalPath;
		await rm(directory, { recursive: true, force: true });
	});
	assert.equal(await loadReadPolicy(), null);
	const policy = createReadPolicy({
		bridgeUser: testConfig.user,
		allowedMailboxes: ["INBOX"],
	});
	await saveReadPolicy(policy);
	await chmod(path, 0o644);
	await Promise.all([
		saveReadPolicy({ ...policy, allowedMailboxes: ["Archive"] }),
		(async () => {
			for (let i = 0; i < 20; i++) assert.ok(await loadReadPolicy());
		})(),
	]);
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	const contents = await readFile(path, "utf8");
	await assert.rejects(saveReadPolicy({ ...policy, allowedMailboxes: [] }));
	assert.equal(await readFile(path, "utf8"), contents);
	assert.deepEqual(await readdir(directory), ["policy.json"]);
	const client = new FakeImap();
	const imap = createImapService(testConfig, async (operation) =>
		operation(client),
	);
	await assert.rejects(
		createReadService(imap, "another@example.com"),
		/not bound/,
	);
	assert.ok(await createReadService(imap, testConfig.user));
	const { bridgeUser: _, ...legacy } = {
		...policy,
		bridgeUser: testConfig.user,
	};
	await writeFile(path, JSON.stringify({ ...legacy, version: 1 }));
	await assert.rejects(createReadService(imap, testConfig.user), /not bound/);
	assert.equal(client.searches.length, 0);
	await writeFile(path, "{corrupt");
	await assert.rejects(loadReadPolicy(), /reset-policy/);
	assert.equal(await hasReadPolicyFile(), true);
	await resetReadPolicy();
	assert.equal(await hasReadPolicyFile(), false);
	process.env.PROTONMAIL_MCP_POLICY_FILE = "  ";
	assert.ok(getPolicyFilePath().endsWith("protonmail-mcp/read-policy.json"));
});

test("setup rejects invalid selections and sender entries without broadening access", () => {
	assert.deepEqual(parseMailboxSelection("2, INBOX, 2", ["INBOX", "Drafts"]), [
		"Drafts",
		"INBOX",
	]);
	for (const answer of ["", "99", "1e0", "missing"])
		assert.throws(() => parseMailboxSelection(answer, ["INBOX"]));
	assert.throws(() => parseSenderEmails("invalid-address"));
	assert.throws(() => parseSenderDomains("https://example.com"));
	assert.deepEqual(parseSenderEmails(""), []);
	assert.deepEqual(parseSenderDomains("PARTNER.TEST"), ["partner.test"]);
});
