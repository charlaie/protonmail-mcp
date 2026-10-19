import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { createImapService } from "../bridge/imap.js";
import { FakeImap, testConfig } from "../bridge/test-fixtures.js";
import { CreateMailboxSchema } from "../inbox/creation.js";
import { createReadPolicy } from "../policy/schema.js";
import { loadReadPolicy, saveReadPolicy } from "../policy/store.js";
import { CreateMailboxOutputSchema } from "./inbox-schemas.js";
import { createServer } from "./server.js";
import { createTestClient } from "./test-client.js";

async function fixture(t: TestContext) {
	const directory = await mkdtemp(join(tmpdir(), "protonmail-create-mailbox-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const policyFile = join(directory, "policy.json");
	const policy = createReadPolicy({
		bridgeUser: testConfig.user,
		allowedTools: ["create_mailbox"],
		allowedMailboxes: ["INBOX"],
		mailboxCreation: ["folder", "label"],
	});
	await saveReadPolicy(policy, policyFile);
	const fake = new FakeImap();
	fake.mailboxes.set("Folders", []);
	fake.mailboxes.set("Labels", []);
	const client = await createTestClient(t, () =>
		createServer({
			config: testConfig,
			policyFile,
			operationsDirectory: directory,
			imap: createImapService(testConfig, async (operation) => operation(fake)),
		}),
	);
	return { fake, client, policy, policyFile };
}

test("folder and label creation supports nested folders and identical retries without expanding access", async (t) => {
	const f = await fixture(t);
	for (const input of [
		{ kind: "folder", name: "Projects" },
		{ kind: "label", name: "Work" },
		{ kind: "folder", name: "2026", parent: "Folders/Projects" },
	]) {
		const first = await f.client.callTool("create_mailbox", input);
		const result = CreateMailboxOutputSchema.parse(first.structuredContent);
		assert.ok("path" in result);
		assert.equal(result.status, "available");
		assert.equal(first.isError, undefined);
		assert.deepEqual(
			(await f.client.callTool("create_mailbox", input)).structuredContent,
			first.structuredContent,
		);
	}
	assert.deepEqual(f.fake.mailboxCreations, [
		"Folders/Projects",
		"Labels/Work",
		"Folders/Projects/2026",
	]);
	assert.deepEqual(await loadReadPolicy(f.policyFile), f.policy);
	assert.equal(f.fake.moves.length + f.fake.deletions, 0);
});

test("creation kinds are disabled by default and enforced independently of the tool grant", async (t) => {
	const f = await fixture(t);
	for (const mailboxCreation of [[], ["label"]] as const) {
		await saveReadPolicy(
			{ ...f.policy, mailboxCreation: [...mailboxCreation] },
			f.policyFile,
		);
		const denied = await f.client.callTool("create_mailbox", {
			kind: "folder",
			name: "Denied",
		});
		assert.equal(denied.isError, true);
		assert.match(JSON.stringify(denied.structuredContent), /POLICY_DENIED/);
	}
	assert.deepEqual(
		createReadPolicy({
			bridgeUser: testConfig.user,
			allowedMailboxes: ["INBOX"],
		}).mailboxCreation,
		[],
	);
	assert.equal(f.fake.mailboxCreations.length, 0);
});

test("revoking creation permission during discovery prevents CREATE", async (t) => {
	const f = await fixture(t);
	const list = f.fake.list.bind(f.fake);
	f.fake.list = async () => {
		const result = await list();
		await saveReadPolicy({ ...f.policy, mailboxCreation: [] }, f.policyFile);
		return result;
	};
	assert.equal(
		(
			await f.client.callTool("create_mailbox", {
				kind: "label",
				name: "Revoked",
			})
		).isError,
		true,
	);
	assert.equal(f.fake.mailboxCreations.length, 0);
});

test("lost CREATE or SUBSCRIBE acknowledgement is recovered by inspecting the exact path on retry", async (t) => {
	const f = await fixture(t);
	const create = f.fake.mailboxCreate.bind(f.fake);
	f.fake.mailboxCreate = async (...args) => {
		await create(...args);
		throw new Error("Connection lost after CREATE");
	};
	const input = { kind: "folder", name: "Recovered" };
	assert.equal(
		(await f.client.callTool("create_mailbox", input)).isError,
		true,
	);
	assert.deepEqual(
		(await f.client.callTool("create_mailbox", input)).structuredContent,
		{ status: "available", kind: "folder", path: "Folders/Recovered" },
	);
	assert.equal(f.fake.mailboxCreations.length, 1);
});

test("creation refuses invalid names, missing namespaces, and parents outside custom folders", async (t) => {
	const f = await fixture(t);
	for (const name of ["", "..", " a", "a/b", "a\\b", "a\r\nb"])
		assert.equal(
			CreateMailboxSchema.safeParse({ kind: "folder", name }).success,
			false,
		);
	for (const parent of [
		"INBOX",
		"Labels",
		"FoldersMissing",
		"Folders/Absent",
	]) {
		assert.equal(
			(
				await f.client.callTool("create_mailbox", {
					kind: "folder",
					name: "Child",
					parent,
				})
			).isError,
			true,
		);
	}
	f.fake.mailboxes.delete("Folders");
	assert.equal(
		(
			await f.client.callTool("create_mailbox", {
				kind: "folder",
				name: "Absent",
			})
		).isError,
		true,
	);
	assert.equal(f.fake.mailboxCreations.length, 0);
});
