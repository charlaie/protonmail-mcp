import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { createImapService } from "@/bridge/imap/service.js";
import {
	FakeImap,
	fixtureMessage,
	testConfig,
} from "@/bridge/testing/fixtures.js";
import { createMailAccess } from "@/mail/access.js";
import { GetMessageSchema } from "@/mail/identity.js";
import { createReadPolicy } from "@/policy/schema.js";
import { saveReadPolicy } from "@/policy/store.js";
import {
	BATCH_READ_LIMITS,
	BatchGetMessagesSchema,
	BatchReadSchema,
} from "./batch.js";

async function fixture(t: TestContext, fake = new FakeImap()) {
	const directory = await mkdtemp(join(tmpdir(), "protonmail-batch-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const policyFile = join(directory, "policy.json");
	await saveReadPolicy(
		createReadPolicy({
			bridgeUser: testConfig.user,
			allowedMailboxes: ["INBOX", "Archive"],
			allowedSenderEmails: ["trusted@example.com"],
		}),
		policyFile,
	);
	let active = 0;
	let peak = 0;
	let sessions = 0;
	const imap = createImapService(testConfig, {
		run: async (operation) => {
			active++;
			peak = Math.max(peak, active);
			sessions++;
			try {
				return await operation(fake);
			} finally {
				active--;
			}
		},
	});
	return {
		fake,
		mail: await createMailAccess(imap, testConfig.user, policyFile),
		work: () => ({ sessions, peak }),
	};
}
function identity(uid: number, mailbox = "INBOX", uidValidity = "7") {
	return GetMessageSchema.parse({ uid, mailbox, uidValidity });
}

class ReadFailureImap extends FakeImap {
	override async fetchOne(...args: Parameters<FakeImap["fetchOne"]>) {
		if (args[0] === "6") throw new Error("FETCH failed");
		return super.fetchOne(...args);
	}
}

test("mixed outcomes preserve order and duplicates, use canonical parsed sender checks, and make no writes/downloads", async (t) => {
	const { fake, mail, work } = await fixture(t, new ReadFailureImap());
	const mismatch = fixtureMessage(4);
	mismatch.source = Buffer.from("From: denied@example.com\r\n\r\nSecret body");
	const oversizedActual = fixtureMessage(7);
	oversizedActual.source = Buffer.alloc(10 * 1024 * 1024 + 1, "x");
	fake.mailboxes.set("INBOX", [
		fixtureMessage(1),
		fixtureMessage(2, { sender: "denied@example.com" }),
		{ ...fixtureMessage(3), size: 10 * 1024 * 1024 + 1 },
		mismatch,
		fixtureMessage(6),
		oversizedActual,
	]);
	fake.mailboxes.set("Archive", [fixtureMessage(1, { text: "From Archive" })]);
	const messages = [
		identity(1, "Archive"),
		identity(1),
		identity(2),
		identity(99),
		identity(1, "INBOX", "8"),
		identity(3),
		identity(4),
		identity(6),
		identity(7),
		identity(1, "Denied mailbox"),
		identity(1),
	];
	const result = BatchReadSchema.parse(
		await mail.batchGetMessages({ messages }),
	);
	assert.deepEqual(
		result.items.map(({ kind }) => kind),
		[
			"found",
			"found",
			"denied",
			"not_found",
			"stale_identity",
			"unavailable",
			"denied",
			"failed",
			"unavailable",
			"denied",
			"found",
		],
	);
	assert.deepEqual(
		result.items.map(({ reference }) => reference),
		messages,
	);
	const archive = result.items[0];
	assert.ok(archive?.kind === "found");
	assert.equal(archive.message.text, "From Archive");
	const failed = result.items[7];
	assert.ok(failed?.kind === "failed");
	assert.equal(failed.error.code, "OPERATION_FAILED");
	assert.equal(result.budget.exhausted, false);
	assert.deepEqual(work(), { sessions: 10, peak: 1 });
	assert.equal(fake.sourceFetches, 5);
	assert.equal(fake.appends.length, 0);
	assert.equal(fake.deletions, 0);
	assert.equal(fake.moves.length, 0);
	assert.equal(fake.flagChanges.length, 0);
	assert.equal(fake.downloads.length, 0);
});

test("character budget returns whole messages, marks the first over-budget and all unattempted items, and stops work", async (t) => {
	const { fake, mail, work } = await fixture(t);
	fake.mailboxes.set("INBOX", [
		fixtureMessage(1, { text: "a".repeat(300_000) }),
		fixtureMessage(2, { text: "b".repeat(300_000) }),
		fixtureMessage(3),
	]);
	const result = await mail.batchGetMessages({
		messages: [identity(1), identity(2), identity(3)],
	});
	assert.deepEqual(
		result.items.map(({ kind }) => kind),
		["found", "budget_exhausted", "budget_exhausted"],
	);
	const first = result.items[0];
	assert.ok(first?.kind === "found");
	assert.equal(first.message.text.length, 300_000);
	assert.equal(result.budget.returnedTextChars, 300_000);
	assert.equal(result.budget.exhausted, true);
	assert.deepEqual(work(), { sessions: 2, peak: 1 });
	assert.equal(fake.sourceFetches, 2);
	assert.ok(
		Buffer.byteLength(JSON.stringify(result, null, 2)) <=
			BATCH_READ_LIMITS.maxBytes,
	);
	// No new limit on the existing single-message default.
	assert.equal((await mail.getMessage(identity(2))).text.length, 300_000);
});

test("byte budget includes UTF-8, escaping, metadata and outcome envelopes independently of text characters", async (t) => {
	for (const text of ["界".repeat(360_000), "\u0001".repeat(180_000)]) {
		const { fake, mail, work } = await fixture(t);
		fake.mailboxes.set("INBOX", [
			fixtureMessage(1, { text }),
			fixtureMessage(2),
		]);
		const result = await mail.batchGetMessages({
			messages: [identity(1), identity(2)],
		});
		assert.deepEqual(
			result.items.map(({ kind }) => kind),
			["budget_exhausted", "budget_exhausted"],
		);
		assert.equal(result.budget.returnedTextChars, 0);
		assert.equal(result.budget.exhausted, true);
		assert.deepEqual(work(), { sessions: 1, peak: 1 });
		assert.ok(
			Buffer.byteLength(JSON.stringify(result, null, 2)) <=
				BATCH_READ_LIMITS.maxBytes,
		);
	}
});

test("large metadata counts toward the byte budget even with a tiny body", async (t) => {
	const { fake, mail, work } = await fixture(t);
	const message = fixtureMessage(1);
	assert.ok(message.envelope);
	message.envelope.subject = "s".repeat(BATCH_READ_LIMITS.maxBytes);
	fake.mailboxes.set("INBOX", [message, fixtureMessage(2)]);
	const result = await mail.batchGetMessages({
		messages: [identity(1), identity(2)],
	});
	assert.deepEqual(
		result.items.map(({ kind }) => kind),
		["budget_exhausted", "budget_exhausted"],
	);
	assert.equal(result.budget.returnedTextChars, 0);
	assert.deepEqual(work(), { sessions: 1, peak: 1 });
	assert.ok(
		Buffer.byteLength(JSON.stringify(result, null, 2)) <=
			BATCH_READ_LIMITS.maxBytes,
	);
});

test("boundary rejects empty, oversized, incomplete and unbounded references before any IMAP work", async (t) => {
	const { mail, work } = await fixture(t);
	for (const messages of [
		[],
		Array.from({ length: 21 }, () => identity(1)),
		[{ uid: 1, mailbox: "INBOX" }],
		[{ ...identity(1), mailbox: "a".repeat(1025) }],
		[{ ...identity(1), uidValidity: "7".repeat(21) }],
	]) {
		assert.equal(BatchGetMessagesSchema.safeParse({ messages }).success, false);
	}
	await assert.rejects(mail.batchGetMessages({ messages: [] }));
	assert.equal(work().sessions, 0);
});
