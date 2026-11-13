import { strict as assert } from "node:assert";
import { test } from "node:test";
import { FakeImap, fixtureMessage } from "@/bridge/testing/fixtures.js";
import { createMessageCache, MESSAGE_CACHE_LIMITS } from "./cache.js";
import { allowAllMessages, readMessage } from "./messages.js";

const identity = { mailbox: "INBOX", uid: 1, uidValidity: "7" };

test("parsed cache expires, checks parsed sender on hits, and isolates returned content", async () => {
	let now = 0;
	const cache = createMessageCache(() => now);
	const client = new FakeImap();
	const message = fixtureMessage(1);
	message.source = Buffer.from("From: parsed@example.com\r\n\r\nContent");
	client.mailboxes.set("INBOX", [message]);
	const first = await readMessage(client, identity, allowAllMessages, cache);
	assert.equal(first.kind, "found");
	assert.ok("value" in first);
	first.value.text = "modified by caller";
	const second = await readMessage(client, identity, allowAllMessages, cache);
	assert.ok("value" in second);
	assert.equal(second.value.text, "Content");
	assert.equal(client.sourceFetches, 1);
	const denied = await readMessage(
		client,
		identity,
		(_mailbox, summary) => !summary.senderEmails.includes("parsed@example.com"),
		cache,
	);
	assert.equal(denied.kind, "denied");
	assert.equal(client.sourceFetches, 1);
	now += MESSAGE_CACHE_LIMITS.ttlMs;
	await readMessage(client, identity, allowAllMessages, cache);
	assert.equal(client.sourceFetches, 2);
});

test("cache evicts least recently used entries and refuses oversized content", async () => {
	const cache = createMessageCache();
	const client = new FakeImap();
	client.mailboxes.set("INBOX", [fixtureMessage(1)]);
	const result = await readMessage(client, identity, allowAllMessages);
	assert.ok("value" in result);
	for (let uid = 1; uid <= MESSAGE_CACHE_LIMITS.maxEntries; uid++)
		cache.set({ ...identity, uid }, result.value);
	assert.ok(cache.get(identity, result.value.size));
	cache.set({ ...identity, uid: 17 }, result.value);
	assert.equal(
		cache.get({ ...identity, uid: 2 }, result.value.size),
		undefined,
	);
	assert.ok(cache.get(identity, result.value.size));
	cache.set(identity, {
		...result.value,
		text: "x".repeat(MESSAGE_CACHE_LIMITS.maxBytes),
	});
	assert.equal(cache.get(identity, result.value.size), undefined);
});
