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
import { GetAttachmentSchema } from "../bridge/schemas.js";
import {
	FakeImap,
	fixtureMessage,
	testConfig,
} from "../bridge/test-fixtures.js";
import { createReadPolicy, ReadPolicySchema } from "./schema.js";
import {
	parseAttachmentApproval,
	parseAttachmentExtensions,
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
	const policyFile = path;
	t.after(async () => {
		await rm(directory, { recursive: true, force: true });
	});
	assert.equal(await loadReadPolicy(policyFile), null);
	const policy = createReadPolicy({
		bridgeUser: testConfig.user,
		allowedMailboxes: ["INBOX"],
	});
	await saveReadPolicy(policy, policyFile);
	await chmod(path, 0o644);
	await Promise.all([
		saveReadPolicy({ ...policy, allowedMailboxes: ["Archive"] }, policyFile),
		(async () => {
			for (let i = 0; i < 20; i++) assert.ok(await loadReadPolicy(policyFile));
		})(),
	]);
	if (process.platform !== "win32")
		assert.equal((await stat(path)).mode & 0o777, 0o600);
	const contents = await readFile(path, "utf8");
	await assert.rejects(
		saveReadPolicy({ ...policy, allowedMailboxes: [] }, policyFile),
	);
	assert.equal(await readFile(path, "utf8"), contents);
	assert.deepEqual(await readdir(directory), ["policy.json"]);
	const client = new FakeImap();
	const imap = createImapService(testConfig, async (operation) =>
		operation(client),
	);
	await assert.rejects(
		createReadService(imap, "another@example.com", policyFile),
		/not bound/,
	);
	assert.ok(await createReadService(imap, testConfig.user, policyFile));
	const { bridgeUser: _, ...legacy } = {
		...policy,
		bridgeUser: testConfig.user,
	};
	await writeFile(path, JSON.stringify({ ...legacy, version: 1 }));
	await assert.rejects(
		createReadService(imap, testConfig.user, policyFile),
		/not bound/,
	);
	assert.equal(client.searches.length, 0);
	await writeFile(path, "{corrupt");
	await assert.rejects(loadReadPolicy(policyFile), /reset-policy/);
	assert.equal(await hasReadPolicyFile(policyFile), true);
	await resetReadPolicy(policyFile);
	assert.equal(await hasReadPolicyFile(policyFile), false);
	assert.ok(
		getPolicyFilePath().endsWith(join("protonmail-mcp", "read-policy.json")),
	);
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
	assert.deepEqual(parseAttachmentExtensions(".PDF, .txt, .pdf"), [
		".pdf",
		".txt",
	]);
	assert.deepEqual(parseAttachmentExtensions(""), []);
	for (const answer of ["y", "YES", " yes "])
		assert.equal(parseAttachmentApproval(answer), true);
	for (const answer of ["", "n", "NO"])
		assert.equal(parseAttachmentApproval(answer), false);
	assert.throws(() => parseAttachmentApproval("maybe"));
	assert.deepEqual(parseAttachmentExtensions("*, .ZIP, .docx, .zip"), [
		"*",
		".zip",
		".docx",
	]);
	for (const answer of [
		"pdf",
		".",
		"../zip",
		".zip/evil",
		".tar.gz",
		".bad\\name",
	])
		assert.throws(() => parseAttachmentExtensions(answer));
});

test("attachment access defaults closed and remains behind account, mailbox, and sender policy", async (t) => {
	const directory = await mkdtemp(
		join(tmpdir(), "protonmail-attachment-policy-"),
	);
	const policyFile = join(directory, "policy.json");
	t.after(async () => {
		await rm(directory, { recursive: true, force: true });
	});
	const policy = createReadPolicy({
		bridgeUser: testConfig.user,
		allowedMailboxes: ["INBOX"],
		allowedSenderEmails: ["trusted@example.com"],
	});
	const {
		allowedAttachmentExtensions: _,
		requireAttachmentApproval: _approval,
		...oldPolicy
	} = policy;
	const parsed = ReadPolicySchema.parse(oldPolicy);
	assert.ok(parsed.version === 3);
	assert.deepEqual(parsed.allowedAttachmentExtensions, []);
	assert.equal(parsed.requireAttachmentApproval, false);
	assert.equal(
		ReadPolicySchema.safeParse({
			...policy,
			allowedAttachmentExtensions: ["../exe"],
		}).success,
		false,
	);
	await saveReadPolicy(policy, policyFile);
	const client = new FakeImap();
	const message = fixtureMessage(1);
	message.bodyStructure = {
		type: "multipart/mixed",
		childNodes: [
			{
				part: "2",
				type: "text/plain",
				size: 7,
				disposition: "attachment",
				dispositionParameters: { filename: "note.txt" },
			},
		],
	};
	client.mailboxes.set("INBOX", [message]);
	client.attachmentContents.set("INBOX:1:2", {
		content: Buffer.from("content"),
		meta: {
			filename: "note.txt",
			contentType: "text/plain",
			disposition: "attachment",
		},
	});
	const imap = createImapService(testConfig, async (operation) =>
		operation(client),
	);
	let reads = await createReadService(imap, testConfig.user, policyFile);
	const input = GetAttachmentSchema.parse({
		mailbox: "INBOX",
		uid: 1,
		uidValidity: "7",
		attachmentId: "2",
	});
	assert.equal(
		(await reads.listAttachments(input)).attachments[0]?.inspection.kind,
		"blocked",
	);
	await assert.rejects(reads.getAttachment(input), /not allowed/);
	assert.equal(client.downloads.length, 0);
	await saveReadPolicy(
		{ ...policy, allowedAttachmentExtensions: [".txt"] },
		policyFile,
	);
	reads = await createReadService(imap, testConfig.user, policyFile);
	assert.equal((await reads.getAttachment(input)).status, "raw");
	assert.equal(client.downloads.length, 1);
	await saveReadPolicy(
		{
			...policy,
			allowedAttachmentExtensions: [".txt"],
			requireAttachmentApproval: true,
		},
		policyFile,
	);
	reads = await createReadService(imap, testConfig.user, policyFile);
	assert.equal(
		(await reads.prepareAttachmentRead(input)).kind,
		"approval_required",
	);
	await assert.rejects(reads.getAttachment(input), /Approval is required/);
	assert.equal(client.downloads.length, 1);
	await saveReadPolicy(
		{ ...policy, allowedAttachmentExtensions: [".txt"] },
		policyFile,
	);
	reads = await createReadService(imap, testConfig.user, policyFile);
	await assert.rejects(
		reads.getAttachment({ ...input, mailbox: "Archive" }),
		/Mailbox/,
	);
	assert.ok(message.envelope);
	message.envelope.from = [{ address: "untrusted@example.com" }];
	await assert.rejects(reads.listAttachments(input), /sender/);
	await assert.rejects(reads.getAttachment(input), /sender/);
	assert.equal(client.downloads.length, 1);
	await assert.rejects(
		createReadService(imap, "different@example.com", policyFile),
		/not bound/,
	);
});
