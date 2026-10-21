import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { simpleParser } from "mailparser";
import {
	CreateDraftSchema,
	EditDraftSchema,
} from "../../mail/drafts/requests.js";
import {
	allowAllWrites,
	permissiveDraftChecks,
} from "../../mail/drafts/test-fixtures.js";
import { createDraftStore } from "../../operations/sqlite/drafts.js";
import { canReadMessage } from "../../policy/enforcement.js";
import { createReadPolicy } from "../../policy/schema.js";
import { hashContent } from "../../shared/content-hash.js";
import { MailError } from "../../shared/mail-error.js";
import { FakeImap, fixtureMessage, testConfig } from "../testing/fixtures.js";
import { allowAllMessages } from "./reading/messages.js";
import { GetThreadSchema, SearchMessagesSchema } from "./reading/requests.js";
import { messageSummary, parsedAddressText } from "./serializers.js";
import { createImapService } from "./service.js";
import { createImapSession } from "./session.js";

const journalDirectory = mkdtempSync(join(tmpdir(), "protonmail-imap-drafts-"));
const mailboxJournals = new WeakMap<FakeImap["mailboxes"], string>();

function journalFor(mailboxes: FakeImap["mailboxes"]) {
	let directory = mailboxJournals.get(mailboxes);
	if (!directory) {
		directory = mkdtempSync(join(journalDirectory, "mailbox-"));
		mailboxJournals.set(mailboxes, directory);
	}
	return directory;
}

after(() => {
	rmSync(journalDirectory, { recursive: true, force: true });
});

function inboxMessage(uid: number) {
	return { mailbox: "INBOX", uid, uidValidity: "7" };
}

function editInput(original: ReturnType<typeof fixtureMessage>, input: object) {
	return EditDraftSchema.parse({
		operationId: randomUUID(),
		expectedRevision: hashContent(original.source?.toString("base64")),
		...input,
	});
}

function service(client: FakeImap) {
	return createImapService(testConfig, {
		run: async (operation) => operation(client),
		draftStore: createDraftStore(testConfig.user, journalFor(client.mailboxes)),
	});
}

const policy = createReadPolicy({
	bridgeUser: testConfig.user,
	allowedMailboxes: ["INBOX", "Archive"],
	allowedSenderEmails: ["trusted@example.com"],
});

const accepts = (mailbox: string, message: ReturnType<typeof messageSummary>) =>
	canReadMessage(policy, { mailbox, message });

test("search filters before limiting and fetches metadata in bounded batches", async () => {
	const client = new FakeImap();
	client.mailboxes.set(
		"INBOX",
		Array.from({ length: 405 }, (_, i) =>
			fixtureMessage(i + 1, {
				sender: i < 5 ? "trusted@example.com" : "other@example.com",
			}),
		),
	);
	const messages = await service(client).searchMessages(
		SearchMessagesSchema.parse({ mailbox: "INBOX", limit: 2 }),
		accepts,
	);
	assert.deepEqual(
		messages.map((message) => message.uid),
		[5, 4],
	);
	assert.equal(messages[0]?.uidValidity, "7");
	assert.ok(client.fetchBatchSizes.every((size) => size <= 200));
	assert.equal(client.sourceFetches, 0);
});

test("failed SEARCH is an error, not an empty result", async () => {
	const client = new FakeImap();
	client.searchFailure = true;
	await assert.rejects(
		service(client).searchMessages(
			SearchMessagesSchema.parse({ mailbox: "INBOX" }),
			allowAllMessages,
		),
		/could not complete/,
	);
});

test("malformed envelope dates fall back to internal date", () => {
	const message = fixtureMessage(1);
	assert.ok(message.envelope);
	Reflect.set(message.envelope, "date", "invalid date");
	assert.equal(messageSummary(message, "7").date, new Date(1000).toISOString());
});

test("denied and oversized messages never fetch source; UIDVALIDITY is checked first", async () => {
	const client = new FakeImap();
	client.mailboxes.set("INBOX", [
		fixtureMessage(1, { sender: "other@example.com" }),
		{ ...fixtureMessage(2), size: 11 * 1024 * 1024 },
	]);
	assert.equal(
		(await service(client).getMessage(inboxMessage(1), accepts)).kind,
		"denied",
	);
	assert.equal(
		(await service(client).getMessage(inboxMessage(2), allowAllMessages)).kind,
		"unavailable",
	);
	await assert.rejects(
		service(client).getMessage(
			{ mailbox: "INBOX", uid: 1, uidValidity: "8" },
			allowAllMessages,
		),
		/UIDVALIDITY changed/,
	);
	assert.equal(client.sourceFetches, 0);
});

test("HTML-only messages become plain text without changing read flags", async () => {
	const client = new FakeImap();
	const message = fixtureMessage(1);
	message.source = Buffer.from(
		"From: trusted@example.com\r\nContent-Type: text/html\r\n\r\n<p>Hello <b>world</b></p>",
	);
	client.mailboxes.set("INBOX", [message]);
	const result = await service(client).getMessage(inboxMessage(1), accepts);
	assert.equal(result.kind, "found");
	assert.equal(result.value.text, "Hello world");
	assert.deepEqual(result.value.flags, ["\\Draft"]);
});

test("message reads enforce the fetched sender and actual source size independently of the envelope", async () => {
	const client = new FakeImap();
	const mismatchedSender = fixtureMessage(1, { sender: "trusted@example.com" });
	mismatchedSender.source = Buffer.from(
		"From: other@example.com\r\n\r\nPrivate body",
	);
	const oversized = fixtureMessage(2);
	oversized.source = Buffer.alloc(10 * 1024 * 1024 + 1, "x");
	client.mailboxes.set("INBOX", [mismatchedSender, oversized]);
	assert.deepEqual(await service(client).getMessage(inboxMessage(1), accepts), {
		kind: "denied",
	});
	const result = await service(client).getMessage(inboxMessage(2), accepts);
	assert.equal(result.kind, "unavailable");
	assert.equal(client.sourceFetches, 2);
});

test("invalid advertised message sizes are refused before fetching source", async () => {
	for (const size of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
		const client = new FakeImap();
		client.mailboxes.set("INBOX", [{ ...fixtureMessage(1), size }]);
		const result = await service(client).getMessage(inboxMessage(1), accepts);
		assert.equal(result.kind, "unavailable");
		assert.equal(client.sourceFetches, 0);
	}
});

test("thread traversal excludes substring collisions and denied senders before its cap", async () => {
	const client = new FakeImap();
	client.mailboxes.set("INBOX", [
		fixtureMessage(1, { id: "<abc@example.com>" }),
		fixtureMessage(2, { id: "<xabc@example.com>" }),
		fixtureMessage(3, {
			references: ["<abc@example.com>"],
			sender: "other@example.com",
		}),
		fixtureMessage(4, { references: ["<abc@example.com>"] }),
	]);
	const result = await service(client).getThread(
		{
			...GetThreadSchema.parse({
				mailbox: "INBOX",
				uid: 1,
				uidValidity: "7",
				limit: 2,
			}),
			mailboxes: ["INBOX", "Archive"],
		},
		accepts,
	);
	assert.equal(result.kind, "found");
	assert.deepEqual(
		result.value.messages.map((message) => message.uid),
		[1, 4],
	);
	assert.equal(result.value.limitReached, true);
	assert.equal(client.searches.length, 1);
	assert.equal(client.sourceFetches, 2);
});

test("thread reconstruction expands successive reply generations and label duplicates once", async () => {
	const client = new FakeImap();
	client.mailboxes.set("INBOX", [
		fixtureMessage(1, { id: "<root@example.com>" }),
		fixtureMessage(2, {
			id: "<reply@example.com>",
			references: ["<root@example.com>"],
		}),
	]);
	client.mailboxes.set("Archive", [
		fixtureMessage(9, {
			id: "<reply@example.com>",
			references: ["<root@example.com>"],
		}),
		fixtureMessage(3, { references: ["<reply@example.com>"] }),
	]);
	const result = await service(client).getThread(
		{
			...GetThreadSchema.parse({
				mailbox: "INBOX",
				uid: 1,
				uidValidity: "7",
				includeText: false,
			}),
			mailboxes: ["INBOX", "Archive"],
		},
		accepts,
	);
	assert.equal(result.kind, "found");
	assert.equal(result.value.messages.length, 3);
	assert.equal(client.sourceFetches, 0);
});

test("draft creation sets Draft and retains Bcc, including an empty composition", async () => {
	const client = new FakeImap();
	await service(client).drafts.create(
		{
			...CreateDraftSchema.parse({
				operationId: randomUUID(),
				bcc: "hidden@example.com",
			}),
			mailbox: "Drafts",
		},
		{ authorize: allowAllWrites },
	);
	const appended = client.appends[0];
	assert.ok(appended);
	assert.ok(appended.flags.includes("\\Draft"));
	const parsed = await simpleParser(appended.content);
	assert.equal(parsedAddressText(parsed.bcc), "hidden@example.com");
});

test("draft edit preserves reply identity and reports a saved replacement after delete failure", async () => {
	const client = new FakeImap();
	const original = fixtureMessage(31);
	original.source = Buffer.from(
		"From: bridge@example.com\r\nMessage-ID: <draft@example.com>\r\nIn-Reply-To: <parent@example.com>\r\nReferences: <root@example.com> <parent@example.com>\r\nReply-To: reply@example.com\r\nContent-Type: text/plain\r\n\r\nOld body",
	);
	client.mailboxes.set("Drafts", [original]);
	client.deleteFailure = "throw";
	const result = await service(client).drafts.edit({
		request: editInput(original, {
			uid: 31,
			uidValidity: "7",
			text: "New body",
		}),
		mailbox: "Drafts",
		...permissiveDraftChecks,
	});
	assert.equal(result.outcome.status, "cleanup_failed");
	assert.ok("identity" in result.outcome);
	assert.equal(result.outcome.identity.uid, 99);
	const appended = client.appends[0];
	assert.ok(appended);
	const parsed = await simpleParser(appended.content);
	assert.match(parsed.messageId ?? "", new RegExp(result.operationId));
	assert.equal(parsed.inReplyTo, "<parent@example.com>");
	assert.deepEqual(parsed.references, [
		"<root@example.com>",
		"<parent@example.com>",
	]);
	assert.equal(parsed.replyTo?.text, "reply@example.com");
});

test("rich drafts and stale identities are blocked before any mutation", async () => {
	const client = new FakeImap();
	const original = fixtureMessage(1);
	original.source = Buffer.from(
		"Content-Type: text/html\r\n\r\n<b>Keep me</b>",
	);
	client.mailboxes.set("Drafts", [original]);
	const input = {
		...editInput(original, { uid: 1, uidValidity: "7", text: "Replacement" }),
		mailbox: "Drafts",
	};
	await assert.rejects(
		service(client).drafts.edit({
			request: input,
			mailbox: "Drafts",
			...permissiveDraftChecks,
		}),
		/HTML/,
	);
	await assert.rejects(
		service(client).drafts.edit({
			request: { ...input, uidValidity: "8" },
			mailbox: "Drafts",
			...permissiveDraftChecks,
		}),
		/UIDVALIDITY changed/,
	);
	assert.equal(client.appends.length, 0);
	assert.equal(client.deletions, 0);
});

test("connection failures close the client and error events reject the operation", async () => {
	const failed = new FakeImap();
	failed.connectFailure = true;
	await assert.rejects(
		createImapSession(testConfig, () => failed)(async () => "unused"),
		/Authentication failed/,
	);
	assert.equal(failed.closed, true);
	const client = new FakeImap();
	await assert.rejects(
		createImapSession(
			testConfig,
			() => client,
		)(async () => {
			client.emit("error", new Error("Socket timed out"));
			throw new Error("Socket timed out");
		}),
		/Socket timed out/,
	);
	assert.equal(client.closed, true);
	const success = new FakeImap();
	assert.equal(
		await createImapSession(testConfig, () => success)(async () => "done"),
		"done",
	);
	assert.equal(success.loggedOut, true);
});

test("cached substring candidates are reconsidered after their IDs become known", async () => {
	const client = new FakeImap();
	client.mailboxes.set("INBOX", [
		fixtureMessage(1, { id: "<x>" }),
		fixtureMessage(2, { id: "<xy>" }),
		fixtureMessage(3, { id: "<b>", references: ["<x> <xy>"] }),
	]);
	const result = await service(client).getThread(
		{
			...GetThreadSchema.parse({
				mailbox: "INBOX",
				uid: 1,
				uidValidity: "7",
				includeText: false,
			}),
			mailboxes: ["INBOX"],
		},
		accepts,
	);
	assert.equal(result.kind, "found");
	assert.deepEqual(
		result.value.messages.map((message) => message.uid),
		[1, 2, 3],
	);
	assert.equal(
		client.fetchBatchSizes.reduce((total, size) => total + size, 0),
		3,
	);
});

test("multiple In-Reply-To IDs find both parents", async () => {
	const client = new FakeImap();
	const anchor = fixtureMessage(1);
	anchor.headers = Buffer.from(
		"Message-ID: <reply>\r\nIn-Reply-To: <a> <b>\r\n\r\n",
	);
	client.mailboxes.set("INBOX", [
		anchor,
		fixtureMessage(2, { id: "<a>" }),
		fixtureMessage(3, { id: "<b>" }),
	]);
	const result = await service(client).getThread(
		{
			...GetThreadSchema.parse({
				mailbox: "INBOX",
				uid: 1,
				uidValidity: "7",
				includeText: false,
			}),
			mailboxes: ["INBOX"],
		},
		accepts,
	);
	assert.equal(result.kind, "found");
	assert.equal(result.value.messages.length, 3);
});

test("thread body limits retain summaries and other available bodies", async () => {
	const client = new FakeImap();
	client.mailboxes.set("INBOX", [
		fixtureMessage(1),
		{
			...fixtureMessage(2, { references: ["<message-1@example.com>"] }),
			size: 11 * 1024 * 1024,
		},
		fixtureMessage(3, {
			references: ["<message-1@example.com>"],
			text: "x".repeat(500_001),
		}),
	]);
	const result = await service(client).getThread(
		{
			...GetThreadSchema.parse(inboxMessage(1)),
			mailboxes: ["INBOX"],
		},
		accepts,
	);
	assert.equal(result.kind, "found");
	assert.deepEqual(
		result.value.messages.map((message) => message.bodyStatus),
		["included", "unavailable", "unavailable"],
	);
	assert.equal(client.sourceFetches, 2);
});

test("a socket error after APPEND retains replacement recovery details through the session", async () => {
	const client = new FakeImap();
	const original = fixtureMessage(32, { sender: "alias@example.com" });
	client.mailboxes.set("Drafts", [original]);
	client.deleteFailure = "event";
	const imap = createImapService(testConfig, {
		run: createImapSession(testConfig, () => client),
		draftStore: createDraftStore(testConfig.user, journalFor(client.mailboxes)),
	});
	const result = await imap.drafts.edit({
		request: editInput(original, {
			uid: 32,
			uidValidity: "7",
			text: "Updated",
		}),
		mailbox: "Drafts",
		...permissiveDraftChecks,
	});
	assert.equal(result.outcome.status, "cleanup_failed");
	assert.ok("identity" in result.outcome);
	assert.equal(result.outcome.identity.uid, 99);
	const appended = client.appends[0];
	assert.ok(appended);
	assert.equal(
		(await simpleParser(appended.content)).from?.value[0]?.address,
		"alias@example.com",
	);
	assert.equal(client.closed, true);
});

test("plain-text drafts with attachments preserve their payload when edits omit attachments", async () => {
	const client = new FakeImap();
	const original = fixtureMessage(33);
	original.source = Buffer.from(
		"MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nBody\r\n--x\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=file.txt\r\n\r\nKeep attachment\r\n--x--",
	);
	client.mailboxes.set("Drafts", [original]);
	const result = await service(client).drafts.edit({
		request: editInput(original, {
			uid: 33,
			uidValidity: "7",
			text: "Replacement",
		}),
		mailbox: "Drafts",
		...permissiveDraftChecks,
	});
	assert.equal(result.outcome.status, "completed");
	assert.equal(client.appends.length, 1);
	const [appended] = client.appends;
	assert.ok(appended);
	const parsed = await simpleParser(appended.content);
	assert.equal(parsed.attachments[0]?.content.toString(), "Keep attachment");
	assert.deepEqual(parsed.attachments[0]?.headers.get("content-type"), {
		value: "application/octet-stream",
		params: { name: "file.txt" },
	});
	assert.equal(client.deletions, 1);
});

test("simultaneous edits on separate IMAP connections create only one replacement", async () => {
	const shared = new Map([
		["Drafts", [fixtureMessage(1, { sender: testConfig.user })]],
	]);
	const clients: FakeImap[] = [];
	const imap = createImapService(testConfig, {
		run: async (operation) => {
			const client = new FakeImap();
			client.mailboxes = shared;
			clients.push(client);
			return operation(client);
		},
		draftStore: createDraftStore(testConfig.user, journalFor(shared)),
	});
	const input = {
		...editInput(fixtureMessage(1, { sender: testConfig.user }), {
			uid: 1,
			uidValidity: "7",
			text: "Changed",
		}),
		mailbox: "Drafts",
	};
	const results = await Promise.all([
		imap.drafts.edit({
			request: input,
			mailbox: "Drafts",
			...permissiveDraftChecks,
		}),
		imap.drafts.edit({
			request: input,
			mailbox: "Drafts",
			...permissiveDraftChecks,
		}),
	]);
	assert.equal(results[0].operationId, results[1].operationId);
	assert.equal(
		(await imap.drafts.get(input.operationId)).outcome.status,
		"completed",
	);
	assert.equal(
		clients.reduce((total, client) => total + client.appends.length, 0),
		1,
	);
});

test("queued edits retain one replacement and its identity after every deletion failure mode", async (t) => {
	for (const [index, mode] of (
		["false", "throw", "event"] as const
	).entries()) {
		await t.test(mode, async () => {
			const uid = 40 + index;
			const shared = new Map([
				["Drafts", [fixtureMessage(uid, { sender: testConfig.user })]],
			]);
			const clients: FakeImap[] = [];
			const imap = createImapService(testConfig, {
				run: (operation) => {
					const client = new FakeImap();
					client.mailboxes = shared;
					client.deleteFailure = mode;
					clients.push(client);
					return createImapSession(testConfig, () => client)(operation);
				},
				draftStore: createDraftStore(testConfig.user, journalFor(shared)),
			});
			const input = {
				...editInput(fixtureMessage(uid, { sender: testConfig.user }), {
					uid,
					uidValidity: "7",
					text: "Changed",
				}),
				mailbox: "Drafts",
			};
			const results = await Promise.all([
				imap.drafts.edit({
					request: input,
					mailbox: "Drafts",
					...permissiveDraftChecks,
				}),
				imap.drafts.edit({
					request: input,
					mailbox: "Drafts",
					...permissiveDraftChecks,
				}),
			]);
			assert.equal(
				(await imap.drafts.get(input.operationId)).outcome.status,
				"cleanup_failed",
			);
			assert.equal(results[1].operationId, results[0].operationId);
			assert.equal(
				(
					await imap.drafts.edit({
						request: input,
						mailbox: "Drafts",
						...permissiveDraftChecks,
					})
				).outcome.status,
				"cleanup_failed",
			);
			assert.equal(
				clients.reduce((total, client) => total + client.appends.length, 0),
				1,
			);
			assert.equal(shared.get("Drafts")?.length, 2);
		});
	}
});

test("session errors preserve typed refusals and distinguish connection failures from operation failures", async () => {
	const disconnected = new FakeImap();
	disconnected.connectFailure = true;
	await assert.rejects(
		createImapSession(testConfig, () => disconnected)(async () => "unused"),
		(error: unknown) =>
			error instanceof MailError &&
			error.code === "CONNECTION_FAILED" &&
			error.retry === "safe",
	);
	await assert.rejects(
		createImapSession(
			testConfig,
			() => new FakeImap(),
		)(async () => {
			throw new Error("Invalid attachment header");
		}),
		(error: unknown) =>
			error instanceof MailError &&
			error.code === "OPERATION_FAILED" &&
			error.retry === "never",
	);
	const refusal = new MailError(
		"UNSUPPORTED_CONTENT",
		"Invalid attachment header",
		"never",
	);
	await assert.rejects(
		createImapSession(
			testConfig,
			() => new FakeImap(),
		)(async () => {
			throw refusal;
		}),
		(error: unknown) => error === refusal,
	);
});
