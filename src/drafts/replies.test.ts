import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { readMessage } from "../bridge/messages.js";
import {
	FakeImap,
	fixtureMessage,
	testConfig,
} from "../bridge/test-fixtures.js";
import { composeReplyDraft } from "./replies.js";
import { CreateReplyDraftSchema } from "./requests.js";

test("reply drafts respect Reply-To, deduplicate reply-all, exclude self and Bcc, and build threading", async () => {
	const client = new FakeImap();
	const source = fixtureMessage(1);
	source.source = Buffer.from(
		"From: author@example.com\r\nReply-To: replies@example.com\r\nTo: bridge@example.com, coworker@example.com\r\nCc: coworker@example.com, alias@example.com, other@example.com\r\nBcc: hidden@example.com\r\nSubject: Question\r\nMessage-ID: <parent@example.com>\r\nReferences: <root@example.com>\r\n\r\nBody",
	);
	client.mailboxes.set("INBOX", [source]);
	const input = CreateReplyDraftSchema.parse({
		operationId: randomUUID(),
		mailbox: "INBOX",
		uid: 1,
		uidValidity: "7",
		replyAll: true,
		text: "Reply",
	});
	const read = await readMessage(client, input, () => true);
	assert.equal(read.kind, "found");
	if (read.kind !== "found") throw new Error("Fixture message missing.");
	const config = {
		...testConfig,
		ownAddresses: [...testConfig.ownAddresses, "alias@example.com"],
	};
	const draft = composeReplyDraft(config, read.value, input, "Drafts");
	assert.deepEqual(draft.to, ["replies@example.com"]);
	assert.deepEqual(draft.cc, ["coworker@example.com", "other@example.com"]);
	assert.equal(draft.bcc, undefined);
	assert.equal(draft.subject, "Re: Question");
	assert.deepEqual(draft.inReplyTo, ["<parent@example.com>"]);
	assert.deepEqual(draft.references, [
		"<root@example.com>",
		"<parent@example.com>",
	]);
	assert.equal(
		composeReplyDraft(
			config,
			read.value,
			{ ...input, replyAll: false },
			"Drafts",
		).cc,
		undefined,
	);
});

test("replying to own sent mail follows up with its recipients and preserves an existing Re subject", async () => {
	const client = new FakeImap();
	const source = fixtureMessage(1, { sender: testConfig.user });
	source.source = Buffer.from(
		`From: ${testConfig.user}\r\nTo: recipient@example.com\r\nSubject: Re: Question\r\nMessage-ID: <sent@example.com>\r\n\r\nBody`,
	);
	client.mailboxes.set("Sent", [source]);
	const input = CreateReplyDraftSchema.parse({
		operationId: randomUUID(),
		mailbox: "Sent",
		uid: 1,
		uidValidity: "7",
	});
	const read = await readMessage(client, input, () => true);
	if (read.kind !== "found") throw new Error("Fixture message missing.");
	const draft = composeReplyDraft(testConfig, read.value, input, "Drafts");
	assert.deepEqual(draft.to, ["recipient@example.com"]);
	assert.equal(draft.subject, "Re: Question");
});

test("reply-all expands To and Cc groups, excludes own aliases inside groups, and ignores Bcc", async () => {
	const client = new FakeImap();
	const source = fixtureMessage(1);
	source.source = Buffer.from(
		"From: author@example.com\r\nTo: Team: alias@example.com, Alice@example.com;\r\nCc: Reviewers: bob@example.com, alice@example.com; , direct@example.com\r\nBcc: Hidden: hidden@example.com;\r\nSubject: Group question\r\nMessage-ID: <group@example.com>\r\n\r\nBody",
	);
	client.mailboxes.set("INBOX", [source]);
	const input = CreateReplyDraftSchema.parse({
		operationId: randomUUID(),
		mailbox: "INBOX",
		uid: 1,
		uidValidity: "7",
		replyAll: true,
	});
	const read = await readMessage(client, input, () => true);
	if (read.kind !== "found") throw new Error("Fixture message missing.");
	const draft = composeReplyDraft(
		{
			...testConfig,
			ownAddresses: [...testConfig.ownAddresses, "alias@example.com"],
		},
		read.value,
		input,
		"Drafts",
	);
	assert.equal(draft.from, "alias@example.com");
	assert.deepEqual(draft.to, ["author@example.com"]);
	assert.deepEqual(draft.cc, [
		"Alice@example.com",
		"bob@example.com",
		"direct@example.com",
	]);
	assert.equal(draft.bcc, undefined);
});
