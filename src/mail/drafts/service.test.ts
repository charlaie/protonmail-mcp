import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { allowAllMessages } from "../../bridge/imap/reading/messages.js";
import {
	FakeImap,
	fixtureMessage,
	testConfig,
} from "../../bridge/testing/fixtures.js";
import { createDraftStore } from "../../operations/sqlite/drafts.js";
import { createSendStore } from "../../operations/sqlite/sending.js";
import { hashContent } from "../../shared/content-hash.js";
import type { SmtpOutcome } from "../sending/model.js";
import { createSendService } from "../sending/service.js";
import { composeDraft } from "./composition/compose.js";
import { CreateDraftSchema, EditDraftSchema } from "./requests.js";
import { createDraftService } from "./service.js";

const identity = { mailbox: "Drafts", uidValidity: "7", uid: 1 };
async function fixture(t: TestContext, client = new FakeImap()) {
	const directory = await mkdtemp(
		join(tmpdir(), "protonmail-draft-lifecycle-"),
	);
	t.after(() => rm(directory, { recursive: true, force: true }));
	const original = fixtureMessage(1, { sender: testConfig.user });
	original.source = Buffer.from(
		`From: ${testConfig.user}\r\nTo: original@example.com\r\nCc: cc@example.com\r\nBcc: bcc@example.com\r\nSubject: Original\r\nMessage-ID: <original@example.com>\r\nIn-Reply-To: <parent@example.com>\r\nReferences: <parent@example.com>\r\n\r\nOriginal body`,
	);
	client.mailboxes.set("Drafts", [original]);
	const store = createDraftStore(testConfig.user, directory);
	const service = () =>
		createDraftService(
			testConfig,
			async (operation) => operation(client),
			createDraftStore(testConfig.user, directory),
		);
	const drafts = service();
	const edit = async (patch: object = {}) =>
		EditDraftSchema.parse({
			operationId: randomUUID(),
			uid: 1,
			uidValidity: "7",
			expectedRevision: (await drafts.read(identity, allowAllMessages))
				.revision,
			...patch,
		});
	return { directory, client, original, store, service, drafts, edit };
}

class LostAppendAcknowledgment extends FakeImap {
	async append(...args: Parameters<FakeImap["append"]>): Promise<never> {
		await super.append(...args);
		throw new Error("APPEND acknowledged to server but connection lost");
	}
}

test("patch edit preserves omitted fields, exposes replacement revision, and rejects a stale revision before APPEND", async (t) => {
	const { drafts, client, edit } = await fixture(t);
	const request = await edit({ text: "New body" });
	await assert.rejects(
		drafts.edit({
			request: { ...request, expectedRevision: "0".repeat(64) },
			mailbox: "Drafts",
		}),
		/revision changed/,
	);
	assert.equal(client.appends.length, 0);
	const result = await drafts.edit({
		request: request,
		mailbox: "Drafts",
	});
	assert.equal(result.outcome.status, "completed");
	assert.ok("identity" in result.outcome);
	const replacement = await drafts.read(
		result.outcome.identity,
		allowAllMessages,
	);
	assert.deepEqual(replacement.to, ["original@example.com"]);
	assert.deepEqual(replacement.cc, ["cc@example.com"]);
	assert.deepEqual(replacement.bcc, ["bcc@example.com"]);
	assert.equal(replacement.subject, "Original");
	assert.equal(replacement.text.trim(), "New body");
	assert.equal(replacement.revision, result.outcome.revision);
	const cleared = await drafts.edit({
		request: EditDraftSchema.parse({
			operationId: randomUUID(),
			...result.outcome.identity,
			expectedRevision: replacement.revision,
			to: [],
			cc: [],
			bcc: [],
			subject: "",
			text: "",
		}),
		mailbox: "Drafts",
	});
	assert.equal(cleared.outcome.status, "completed");
	assert.ok("identity" in cleared.outcome);
	const unfinished = await drafts.read(
		cleared.outcome.identity,
		allowAllMessages,
	);
	assert.deepEqual(unfinished.to, []);
	assert.deepEqual(unfinished.cc, []);
	assert.deepEqual(unfinished.bcc, []);
	assert.equal(unfinished.subject, "");
	assert.equal(unfinished.text.trim(), "");
});

test("draft sender checks run before source fetch and recheck the fetched sender", async (t) => {
	const { drafts, client, original } = await fixture(t);
	await assert.rejects(
		drafts.read(identity, () => false),
		/not allowed/,
	);
	assert.equal(client.sourceFetches, 0);
	original.source = Buffer.from("From: changed@example.com\r\n\r\nBody");
	await assert.rejects(
		drafts.read(identity, (_mailbox, message) =>
			message.senderEmails.includes(testConfig.user),
		),
		/Fetched draft sender/,
	);
});

test("uncertain create APPEND survives restart and replays the same ID without a second append", async (t) => {
	const { drafts, service, client } = await fixture(
		t,
		new LostAppendAcknowledgment(),
	);
	const input = {
		...CreateDraftSchema.parse({
			operationId: randomUUID(),
			to: "recipient@example.com",
			text: "Keep me",
		}),
		mailbox: "Drafts",
	};
	const uncertain = await drafts.create(input);
	assert.equal(uncertain.outcome.status, "appending");
	assert.equal((await service().create(input)).outcome.status, "appending");
	assert.equal(client.appends.length, 1);
	await assert.rejects(
		service().create({ ...input, text: "Different" }),
		/another request/,
	);
	const saved = await service().reconcile(input.operationId, allowAllMessages);
	assert.equal(saved.outcome.status, "completed");
	assert.equal(client.appends.length, 1);
	assert.equal(client.deletions, 0);
	assert.deepEqual(await service().create(input), saved);
});

test("recovery accepts a harmless Received header but refuses changed content and duplicate exact copies", async (t) => {
	for (const mode of ["received", "body", "recipient", "duplicate"] as const) {
		await t.test(mode, async (t) => {
			const { drafts, client } = await fixture(
				t,
				new LostAppendAcknowledgment(),
			);
			const input = {
				...CreateDraftSchema.parse({
					operationId: randomUUID(),
					to: "CaseSensitive@example.com",
					text: "Original content",
				}),
				mailbox: "Drafts",
			};
			await drafts.create(input);
			const saved = client.mailboxes
				.get("Drafts")
				?.find((message) => message.uid === 99);
			assert.ok(saved?.source);
			if (mode === "received")
				saved.source = Buffer.concat([
					Buffer.from("Received: by bridge.local\r\n"),
					saved.source,
				]);
			if (mode === "body")
				saved.source = Buffer.from(
					saved.source
						.toString()
						.replace("Original content", "Changed content"),
				);
			if (mode === "recipient")
				saved.source = Buffer.from(
					saved.source
						.toString()
						.replace("CaseSensitive@example.com", "casesensitive@example.com"),
				);
			if (mode === "duplicate")
				client.mailboxes.get("Drafts")?.push({ ...saved, uid: 100, seq: 100 });
			if (mode === "received")
				assert.equal(
					(await drafts.reconcile(input.operationId, allowAllMessages)).outcome
						.status,
					"completed",
				);
			else
				await assert.rejects(
					drafts.reconcile(input.operationId, allowAllMessages),
					/different content|multiple exact copies/,
				);
			assert.equal(client.appends.length, 1);
			assert.equal(client.deletions, 0);
		});
	}
});

test("no exact recovery match preserves uncertainty and never re-appends", async (t) => {
	const { drafts, client } = await fixture(t, new LostAppendAcknowledgment());
	const input = {
		...CreateDraftSchema.parse({ operationId: randomUUID() }),
		mailbox: "Drafts",
	};
	await drafts.create(input);
	client.mailboxes.set("Drafts", []);
	assert.equal(
		(await drafts.reconcile(input.operationId, allowAllMessages)).outcome
			.status,
		"appending",
	);
	await drafts.create(input);
	assert.equal(client.appends.length, 1);
});

test("uncertain edit retires original and blocks replacement mutations until reconciliation and cleanup", async (t) => {
	const { drafts, client, service, edit } = await fixture(
		t,
		new LostAppendAcknowledgment(),
	);
	const input = { ...(await edit({ text: "Replacement" })), mailbox: "Drafts" };
	await drafts.edit({ request: input, mailbox: "Drafts" });
	await assert.rejects(
		service().edit({
			request: { ...input, operationId: randomUUID() },
			mailbox: "Drafts",
		}),
		/reserved by operation/,
	);
	const replacementIdentity = { ...identity, uid: 99 };
	const replacement = await drafts.read(replacementIdentity, allowAllMessages);
	await assert.rejects(
		service().edit({
			request: {
				...input,
				...replacementIdentity,
				operationId: randomUUID(),
				expectedRevision: replacement.revision,
			},
			mailbox: "Drafts",
		}),
		/reserved by operation/,
	);
	const reconciled = await service().reconcile(
		input.operationId,
		allowAllMessages,
	);
	assert.equal(reconciled.outcome.status, "saved");
	assert.equal(client.deletions, 0);
	const completed = await service().retryCleanup(
		input.operationId,
		allowAllMessages,
	);
	assert.equal(completed.outcome.status, "completed");
	assert.equal(client.deletions, 1);
	assert.equal(client.appends.length, 1);
});

test("submitting, uncertain, partial, and accepted sends with retained drafts cannot edit into a new UID", async (t) => {
	const outcomes: SmtpOutcome[] = [
		{ status: "uncertain", reason: "Connection lost" },
		{
			status: "partially_accepted",
			accepted: ["original@example.com"],
			rejected: ["bcc@example.com"],
		},
		{ status: "accepted", accepted: ["original@example.com"], rejected: [] },
	];
	for (const outcome of outcomes)
		await t.test(outcome.status, async (t) => {
			const { drafts, client, directory, edit } = await fixture(t);
			let submissions = 0;
			const sends = createSendService(testConfig, {
				store: createSendStore(testConfig.user, directory),
				submit: async () => {
					submissions++;
					return outcome;
				},
			});
			const snapshot = await drafts.snapshot(identity, allowAllMessages);
			const source = {
				kind: "draft" as const,
				...identity,
				fingerprint: snapshot.fingerprint,
				draftMessageId: snapshot.draftMessageId,
			};
			const operationId = randomUUID();
			const record = await sends.prepare({
				operationId,
				request: { operationId },
				message: snapshot.message,
				source,
			});
			await sends.send(record, snapshot.message, async () => ({
				status: "failed",
				reason: "Deletion interrupted",
			}));
			await assert.rejects(
				drafts.edit({
					request: await edit(),
					mailbox: "Drafts",
				}),
				/reserved by operation/,
			);
			assert.equal(client.appends.length, 0);
			const secondId = randomUUID();
			const second = await sends.prepare({
				operationId: secondId,
				request: { secondId },
				message: snapshot.message,
				source,
			});
			await assert.rejects(
				sends.send(second, snapshot.message),
				/reserved by operation/,
			);
			assert.equal(submissions, 1);
		});
});

test("edit and send claims exclude each other atomically across stores and a separate process", async (t) => {
	const { drafts, client, directory, edit } = await fixture(t);
	const input = { ...(await edit()), mailbox: "Drafts" };
	client.deleteFailure = "throw";
	const mutation = await drafts.edit({ request: input, mailbox: "Drafts" });
	assert.equal(mutation.outcome.status, "cleanup_failed");
	const snapshot = await drafts.snapshot(identity, allowAllMessages);
	let attempts = 0;
	const sends = createSendService(testConfig, {
		store: createSendStore(testConfig.user, directory),
		submit: async () => {
			attempts++;
			return { status: "accepted", accepted: [], rejected: [] };
		},
	});
	const id = randomUUID();
	const record = await sends.prepare({
		operationId: id,
		request: { id },
		message: snapshot.message,
		source: { kind: "draft", ...identity, fingerprint: snapshot.fingerprint },
	});
	await assert.rejects(
		sends.send(record, snapshot.message),
		/reserved by operation/,
	);
	assert.equal(attempts, 0);
	const child = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`import { createSendStore } from ${JSON.stringify(new URL("../../operations/sqlite/sending.js", import.meta.url).href)}; try { await createSendStore(${JSON.stringify(testConfig.user)}, ${JSON.stringify(directory)}).claim(${JSON.stringify(id)}, ${JSON.stringify(record.contentHash)}); process.exit(2); } catch(error) { process.exit(error.code === "OPERATION_CONFLICT" ? 0 : 3); }`,
		],
		{ encoding: "utf8" },
	);
	assert.equal(child.status, 0, child.stderr);
	assert.equal((await sends.get(id)).outcome.status, "prepared");
});

test("content unavailable on an existing UID cannot complete either cleanup path", async (t) => {
	const { drafts, client, original, edit } = await fixture(t);
	client.deleteFailure = "throw";
	const record = await drafts.edit({
		request: await edit(),
		mailbox: "Drafts",
	});
	assert.equal(record.outcome.status, "cleanup_failed");
	assert.ok("identity" in record.outcome);
	client.deleteFailure = "none";
	original.source = undefined;
	const result = await drafts.retryCleanup(
		record.operationId,
		allowAllMessages,
	);
	assert.equal(result.outcome.status, "cleanup_failed");
	assert.equal(client.deletions, 1);
	await assert.rejects(
		drafts.deleteSnapshot(identity, "old fingerprint", allowAllMessages),
		/exists but its content is unavailable/,
	);
	const replacement = await drafts.read(
		record.outcome.identity,
		allowAllMessages,
	);
	await assert.rejects(
		drafts.edit({
			request: EditDraftSchema.parse({
				...record.outcome.identity,
				operationId: randomUUID(),
				expectedRevision: replacement.revision,
				text: "Changed",
			}),
			mailbox: "Drafts",
		}),
		/reserved by operation/,
	);
});

test("cleanup retries preserve source and replacement revision checks and detect mailbox resets", async (t) => {
	for (const mode of ["original", "replacement", "uidvalidity"] as const)
		await t.test(mode, async (t) => {
			const { drafts, client, original, edit } = await fixture(t);
			client.deleteFailure = "throw";
			const record = await drafts.edit({
				request: await edit(),
				mailbox: "Drafts",
			});
			assert.equal(record.outcome.status, "cleanup_failed");
			client.deleteFailure = "none";
			if (mode === "original")
				original.source = Buffer.from(
					`${original.source?.toString()}\r\nChanged`,
				);
			if (mode === "replacement") {
				const replacement = client.mailboxes
					.get("Drafts")
					?.find((message) => message.uid === 99);
				assert.ok(replacement?.source);
				replacement.source = Buffer.from(
					`${replacement.source.toString()}\r\nChanged`,
				);
			}
			if (mode === "uidvalidity") client.uidValidity = 8n;
			assert.equal(
				(await drafts.retryCleanup(record.operationId, allowAllMessages))
					.outcome.status,
				"cleanup_failed",
			);
			assert.equal(client.deletions, 1);
		});
});

test("late append completion and failed cleanup cannot regress an already completed draft operation", async (t) => {
	const { store, directory } = await fixture(t);
	const operationId = randomUUID();
	const composed = await composeDraft(testConfig, {
		...CreateDraftSchema.parse({ operationId }),
		mailbox: "Drafts",
	});
	const now = new Date().toISOString();
	await store.claim({
		operationId,
		requestHash: hashContent({ operationId }),
		messageId: composed.messageId,
		contentHash: composed.contentHash,
		mailbox: "Drafts",
		source: { kind: "edit", ...identity, revision: "original" },
		createdAt: now,
		updatedAt: now,
		outcome: { status: "appending" },
	});
	const other = createDraftStore(testConfig.user, directory);
	await other.saved(operationId, { ...identity, uid: 99 }, "replacement");
	await other.cleanup(operationId, { status: "completed" });
	await store.saved(operationId, { ...identity, uid: 100 }, "late");
	await store.cleanup(operationId, {
		status: "cleanup_failed",
		reason: "Late failure",
	});
	const final = await store.get(operationId);
	assert.equal(final?.outcome.status, "completed");
	assert.ok(final && "identity" in final.outcome);
	assert.equal(final.outcome.identity.uid, 99);
});

test("an in-flight SMTP claim blocks editing before the transport outcome exists", async (t) => {
	const { drafts, client, directory, edit } = await fixture(t);
	let finish: (outcome: SmtpOutcome) => void = () => {};
	let start: () => void = () => {};
	const started = new Promise<void>((resolve) => {
		start = resolve;
	});
	const sends = createSendService(testConfig, {
		store: createSendStore(testConfig.user, directory),
		submit: () => {
			start();
			return new Promise<SmtpOutcome>((resolve) => {
				finish = resolve;
			});
		},
	});
	const snapshot = await drafts.snapshot(identity, allowAllMessages);
	const record = await sends.prepare({
		operationId: randomUUID(),
		request: {},
		message: snapshot.message,
		source: { kind: "draft", ...identity, fingerprint: snapshot.fingerprint },
	});
	const sending = sends.send(record, snapshot.message);
	await started;
	await assert.rejects(
		drafts.edit({
			request: await edit(),
			mailbox: "Drafts",
		}),
		/reserved by operation/,
	);
	assert.equal(client.appends.length, 0);
	finish({ status: "uncertain", reason: "Interrupted" });
	await sending;
});

test("reconciliation can complete edit cleanup before a delayed APPEND acknowledgment without state regression", async (t) => {
	let release: () => void = () => {};
	let signal: () => void = () => {};
	const appended = new Promise<void>((resolve) => {
		signal = resolve;
	});
	class DelayedAppend extends FakeImap {
		async append(...args: Parameters<FakeImap["append"]>) {
			const result = await super.append(...args);
			signal();
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return result;
		}
	}
	const { drafts, service, client, edit } = await fixture(
		t,
		new DelayedAppend(),
	);
	const input = { ...(await edit({ text: "Replacement" })), mailbox: "Drafts" };
	const editing = drafts.edit({ request: input, mailbox: "Drafts" });
	await appended;
	const other = service();
	assert.equal(
		(await other.reconcile(input.operationId, allowAllMessages)).outcome.status,
		"saved",
	);
	assert.equal(
		(await other.retryCleanup(input.operationId, allowAllMessages)).outcome
			.status,
		"completed",
	);
	release();
	assert.equal((await editing).outcome.status, "completed");
	assert.equal(
		(await drafts.get(input.operationId)).outcome.status,
		"completed",
	);
	assert.equal(client.appends.length, 1);
	assert.equal(client.deletions, 1);
});

test("replacement send stays blocked when APPEND succeeded but saving its identity failed", async (t) => {
	const { directory, client, edit, store } = await fixture(t);
	const drafts = createDraftService(
		testConfig,
		async (operation) => operation(client),
		{
			...store,
			saved: async () => {
				throw new Error("Journal result write unavailable");
			},
		},
	);
	const input = { ...(await edit({ text: "Replacement" })), mailbox: "Drafts" };
	const uncertain = await drafts.edit({ request: input, mailbox: "Drafts" });
	assert.equal(uncertain.outcome.status, "appending");
	let submissions = 0;
	const sends = createSendService(testConfig, {
		store: createSendStore(testConfig.user, directory),
		submit: async () => {
			submissions++;
			return { status: "accepted", accepted: [], rejected: [] };
		},
	});
	const snapshot = await drafts.snapshot(
		{ ...identity, uid: 99 },
		allowAllMessages,
	);
	const record = await sends.prepare({
		operationId: randomUUID(),
		request: {},
		message: snapshot.message,
		source: {
			kind: "draft",
			...identity,
			uid: 99,
			fingerprint: snapshot.fingerprint,
			draftMessageId: snapshot.draftMessageId,
		},
	});
	await assert.rejects(
		sends.send(record, snapshot.message),
		/reserved by operation/,
	);
	assert.equal(submissions, 0);
	assert.equal(client.appends.length, 1);
	const recovered = createDraftService(
		testConfig,
		async (operation) => operation(client),
		createDraftStore(testConfig.user, directory),
	);
	assert.equal(
		(await recovered.reconcile(input.operationId, allowAllMessages)).outcome
			.status,
		"saved",
	);
	// The known replacement identity also blocks callers with legacy source records lacking draftMessageId.
	const legacy = await sends.prepare({
		operationId: randomUUID(),
		request: {},
		message: snapshot.message,
		source: {
			kind: "draft",
			...identity,
			uid: 99,
			fingerprint: snapshot.fingerprint,
		},
	});
	await assert.rejects(
		sends.send(legacy, snapshot.message),
		/reserved by operation/,
	);
	assert.equal(submissions, 0);
});

test("same-ID edit replays a completed operation when another process removes the original during preflight", async (t) => {
	const { drafts, client, directory, edit } = await fixture(t);
	let release: () => void = () => {};
	let signal: () => void = () => {};
	const paused = new Promise<void>((resolve) => {
		signal = resolve;
	});
	class PausedPreflight extends FakeImap {
		private pause = true;
		async mailboxOpen(...args: Parameters<FakeImap["mailboxOpen"]>) {
			if (this.pause) {
				this.pause = false;
				signal();
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			}
			return super.mailboxOpen(...args);
		}
	}
	const otherClient = new PausedPreflight();
	otherClient.mailboxes = client.mailboxes;
	const other = createDraftService(
		testConfig,
		async (operation) => operation(otherClient),
		createDraftStore(testConfig.user, directory),
	);
	const input = { ...(await edit({ text: "Replacement" })), mailbox: "Drafts" };
	const delayed = other.edit({ request: input, mailbox: "Drafts" });
	await paused;
	const completed = await drafts.edit({ request: input, mailbox: "Drafts" });
	assert.equal(completed.outcome.status, "completed");
	release();
	assert.deepEqual(await delayed, completed);
	assert.equal(client.appends.length + otherClient.appends.length, 1);
	assert.equal(client.deletions + otherClient.deletions, 1);
});
