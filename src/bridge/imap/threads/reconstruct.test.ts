import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { FetchMessageObject } from "imapflow";
import { simpleParser } from "mailparser";
import { GetThreadSchema } from "@/bridge/imap/reading/requests.js";
import { FakeImap, fixtureMessage } from "@/bridge/testing/fixtures.js";
import { bridgeThreadIdentity } from "./identity.js";
import { getThread } from "./reconstruct.js";

function message(input: {
	uid: number;
	messageId?: string;
	internalId?: string;
	externalId?: string;
	references?: string;
	sender?: string;
}) {
	const result = fixtureMessage(input.uid, {
		id: input.messageId,
		sender: input.sender,
	});
	assert.ok(result.envelope);
	result.envelope.messageId = input.messageId;
	result.headers = Buffer.from(
		[
			`From: ${input.sender ?? "trusted@example.com"}`,
			...(input.messageId ? [`Message-ID: ${input.messageId}`] : []),
			...(input.internalId ? [`X-Pm-Internal-Id: ${input.internalId}`] : []),
			...(input.externalId ? [`X-Pm-External-Id: ${input.externalId}`] : []),
			...(input.references ? [`References: ${input.references}`] : []),
			"",
			"",
		].join("\r\n"),
	);
	return result;
}

async function thread(client: FakeImap, uid = 1) {
	const result = await getThread(
		client,
		{
			...GetThreadSchema.parse({
				mailbox: "INBOX",
				uid,
				uidValidity: "7",
				includeText: false,
			}),
			mailboxes: ["INBOX", "Archive"],
		},
		(mailbox, summary) =>
			["INBOX", "Archive"].includes(mailbox) &&
			summary.senderEmails.includes("trusted@example.com"),
	);
	assert.equal(result.kind, "found");
	assert.ok("value" in result);
	return result.value;
}

test("internal Bridge identity connects synthetic reply references and deduplicates mixed mailbox projections", async () => {
	const client = new FakeImap();
	client.mailboxes.set("INBOX", [
		message({
			uid: 1,
			messageId: "<original@example.com>",
			internalId: "parent-id",
		}),
		message({
			uid: 2,
			messageId: "<reply@example.com>",
			references: "<parent-id@protonmail.internalid>",
		}),
		message({
			uid: 3,
			messageId: "<unrelated@example.com>",
			internalId: "xparent-id",
		}),
		message({
			uid: 4,
			messageId: "<denied@example.com>",
			references: "<parent-id@protonmail.internalid>",
			sender: "denied@example.com",
		}),
	]);
	client.mailboxes.set("Archive", [
		message({
			uid: 9,
			messageId: "<parent-id@protonmail.internalid>",
			internalId: "parent-id",
			externalId: "<original@example.com>",
		}),
	]);
	client.mailboxes.set("Secret", [
		message({
			uid: 5,
			messageId: "<secret@example.com>",
			references: "<reply@example.com>",
		}),
	]);
	const result = await thread(client);
	assert.deepEqual(
		result.messages.map((item) => item.uid),
		[1, 2],
	);
	assert.equal(result.threadKey, "original@example.com");
	assert.equal(client.sourceFetches, 0);
	assert.match(JSON.stringify(client.searches), /X-Pm-Internal-Id/);
	assert.match(JSON.stringify(client.searches), /X-Pm-External-Id/);
});

test("starting from a synthetic reference discovers the parent through its bare internal header", async () => {
	const client = new FakeImap();
	client.mailboxes.set("INBOX", [
		message({
			uid: 1,
			messageId: "<reply@example.com>",
			references: "<parent-id@protonmail.internalid>",
		}),
	]);
	client.mailboxes.set("Archive", [
		message({
			uid: 2,
			messageId: "<original@example.com>",
			internalId: "parent-id",
		}),
	]);
	assert.equal((await thread(client)).messages.length, 2);
	assert.ok(
		client.searches.some((query) =>
			query.or?.some(
				(term) => term.header?.["X-Pm-Internal-Id"] === "parent-id",
			),
		),
	);
});

test("external Bridge identity bridges an otherwise disconnected reply chain", async () => {
	const client = new FakeImap();
	client.mailboxes.set("INBOX", [
		message({
			uid: 1,
			messageId: "<bridge-generated@protonmail.internalid>",
			externalId: "<original@example.com>",
		}),
		message({
			uid: 2,
			messageId: "<reply@example.com>",
			references: "<original@example.com>",
		}),
	]);
	assert.equal((await thread(client)).messages.length, 2);
});

test("identities absent from Message-ID still deduplicate by Bridge ID and retain standard reply links", async () => {
	const client = new FakeImap();
	const root = message({ uid: 1, internalId: "parent-id" });
	client.mailboxes.set("INBOX", [
		root,
		message({
			uid: 2,
			messageId: "<child@example.com>",
			references: "<parent-id@protonmail.internalid>",
		}),
	]);
	client.mailboxes.set("Archive", [
		message({ uid: 9, internalId: "parent-id" }),
	]);
	assert.equal((await thread(client)).messages.length, 2);
});

test("Bridge's own synthetic References entry is not mistaken for a conversation root", async () => {
	const client = new FakeImap();
	client.mailboxes.set("INBOX", [
		message({
			uid: 1,
			messageId: "<original@example.com>",
			internalId: "self",
			references: "<self@protonmail.internalid>",
		}),
	]);
	assert.equal((await thread(client)).threadKey, "original@example.com");
});

test("malformed or repeated Bridge identities fall back to standard headers", async () => {
	for (const extra of [
		"X-Pm-Internal-Id: bad id\r\nX-Pm-External-Id: <a> <b>",
		"X-Pm-Internal-Id: first\r\nX-Pm-Internal-Id: second",
		"X-Pm-Internal-Id: <invalid>",
	]) {
		const client = new FakeImap();
		const root: FetchMessageObject = message({
			uid: 1,
			messageId: "<root@example.com>",
		});
		root.headers = Buffer.from(
			`From: trusted@example.com\r\nMessage-ID: <root@example.com>\r\n${extra}\r\n\r\n`,
		);
		assert.deepEqual(
			bridgeThreadIdentity((await simpleParser(root.headers)).headers),
			{ bridgeInternalId: undefined, bridgeExternalId: undefined },
		);
		client.mailboxes.set("INBOX", [
			root,
			message({
				uid: 2,
				messageId: "<reply@example.com>",
				references: "<root@example.com>",
			}),
		]);
		assert.equal((await thread(client)).messages.length, 2);
	}
});

test("malformed external aliases cannot collapse unrelated parents or attach their replies", async () => {
	for (const externalId of [
		"garbage <root@example.com> trailing",
		"<root@example.com> <root@example.com>",
		"<root@example.com> <>",
	]) {
		const client = new FakeImap();
		client.mailboxes.set("INBOX", [
			message({ uid: 1, messageId: "<root@example.com>" }),
			message({ uid: 2, messageId: "<unrelated@example.com>", externalId }),
			message({
				uid: 3,
				messageId: "<reply@example.com>",
				references: "<unrelated@example.com>",
			}),
		]);
		assert.deepEqual(
			(await thread(client)).messages.map((item) => item.uid),
			[1],
		);
		assert.deepEqual(
			(await thread(client, 2)).messages.map((item) => item.uid),
			[2, 3],
		);
	}
});
