import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { allowAllMessages } from "../bridge/messages.js";
import { SendEmailSchema } from "../bridge/schemas.js";
import {
	FakeImap,
	fixtureMessage,
	testConfig,
} from "../bridge/test-fixtures.js";
import { newEmailMessage } from "../sending/model.js";
import { createSendService } from "../sending/service.js";
import { createSendStore } from "../sending/store.js";
import { MailError } from "../shared/mail-error.js";
import { inboxPlan } from "./mailboxes.js";
import {
	InboxActionNameSchema,
	type ManageMessageInput,
	ManageMessageSchema,
} from "./model.js";
import { createInboxService } from "./service.js";
import { createInboxStore } from "./store.js";

async function fixture(t: TestContext, client = new FakeImap()) {
	const directory = await mkdtemp(join(tmpdir(), "protonmail-inbox-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const message = fixtureMessage(1);
	message.flags = new Set(["custom"]);
	client.mailboxes.set("INBOX", [message]);
	for (const name of ["Archive", "Trash", "Labels/Work", "Drafts"])
		client.mailboxes.set(name, []);
	client.capabilities.set("MOVE", true);
	const store = createInboxStore(testConfig.user, directory);
	const service = createInboxService(
		testConfig,
		async (operation) => operation(client),
		store,
	);
	const authorize = async () => allowAllMessages;
	function request(change: ManageMessageInput["change"]) {
		return ManageMessageSchema.parse({
			operationId: randomUUID(),
			mailbox: "INBOX",
			uid: 1,
			uidValidity: "7",
			change,
		});
	}
	return { directory, client, message, store, service, authorize, request };
}

test("read and star operations preserve unrelated flags, replay without a second STORE, and skip existing desired state", async (t) => {
	const f = await fixture(t);
	for (const action of ["mark_read", "star", "mark_unread", "unstar"]) {
		const request = f.request({
			action: InboxActionNameSchema.extract([
				"mark_read",
				"star",
				"mark_unread",
				"unstar",
			]).parse(action),
		});
		const result = await f.service.manage(request, f.authorize);
		assert.equal(result.outcome.status, "completed");
		assert.deepEqual(await f.service.manage(request, f.authorize), result);
	}
	assert.equal(f.client.flagChanges.length, 4);
	assert.deepEqual(f.message.flags, new Set(["custom"]));
	assert.equal(
		(await f.service.manage(f.request({ action: "mark_unread" }), f.authorize))
			.outcome.status,
		"completed",
	);
	assert.equal(f.client.flagChanges.length, 4);
	assert.equal(f.client.sourceFetches, 0);
});

test("archive and Trash use native MOVE and replay an accepted move after its source disappears", async (t) => {
	for (const action of ["archive", "trash"])
		await t.test(action, async (t) => {
			const f = await fixture(t);
			const request = f.request({
				action: InboxActionNameSchema.extract(["archive", "trash"]).parse(
					action,
				),
			});
			const result = await f.service.manage(request, f.authorize);
			assert.equal(result.outcome.status, "completed");
			assert.equal(f.client.moves.length, 1);
			assert.equal(f.client.deletions, 0);
			assert.equal(f.client.mailboxes.get("INBOX")?.length, 0);
			const reopened = createInboxService(
				testConfig,
				async (operation) => operation(f.client),
				createInboxStore(testConfig.user, f.directory),
			);
			assert.deepEqual(await reopened.manage(request, f.authorize), result);
			await assert.rejects(
				reopened.manage(
					{ ...request, change: { action: "star" } },
					f.authorize,
				),
				/another request/,
			);
			assert.equal(f.client.moves.length, 1);
		});
});

test("All Mail and Starred views cannot implicitly change placement or stars through MOVE", async (t) => {
	const f = await fixture(t);
	for (const view of ["All Mail", "Starred"]) {
		f.client.mailboxes.set(view, [f.message]);
		await assert.rejects(
			f.service.manage(
				f.request({ action: "move", destination: view }),
				f.authorize,
			),
			/views/,
		);
		await assert.rejects(
			f.service.manage(
				{ ...f.request({ action: "archive" }), mailbox: view },
				f.authorize,
			),
			/views/,
		);
	}
	assert.equal(f.client.moves.length, 0);
	assert.equal(
		(await f.service.capabilities()).mailboxes.filter(
			(item) => item.kind === "view",
		).length,
		2,
	);
});

test("acknowledged unstar may remove its Starred projection, while lost acknowledgement remains uncertain", async (t) => {
	class StarredProjectionImap extends FakeImap {
		loseAcknowledgement = false;
		override async messageFlagsRemove(
			...args: Parameters<FakeImap["messageFlagsRemove"]>
		) {
			const result = await super.messageFlagsRemove(...args);
			this.mailboxes.set("Starred", []);
			if (this.loseAcknowledgement)
				throw new Error("Lost STORE acknowledgement");
			return result;
		}
	}
	for (const loseAcknowledgement of [false, true]) {
		const client = new StarredProjectionImap();
		const f = await fixture(t, client);
		f.message.flags?.add("\\Flagged");
		client.mailboxes.set("Starred", [f.message]);
		client.loseAcknowledgement = loseAcknowledgement;
		const request = { ...f.request({ action: "unstar" }), mailbox: "Starred" };
		const record = await f.service.manage(request, f.authorize);
		assert.equal(
			record.outcome.status,
			loseAcknowledgement ? "uncertain" : "completed",
		);
		assert.deepEqual(await f.service.manage(request, f.authorize), record);
		assert.deepEqual(
			await f.service.reconcile(request.operationId, f.authorize),
			record,
		);
		assert.equal(client.flagChanges.length, 1);
		assert.equal(f.message.flags?.has("\\Flagged"), false);
	}
});

test("unsupported MOVE, unavailable permanent flags, stale identity, disallowed sender and drafts never mutate", async (t) => {
	const f = await fixture(t);
	f.client.capabilities.delete("MOVE");
	await assert.rejects(
		f.service.manage(f.request({ action: "archive" }), f.authorize),
		/native MOVE/,
	);
	f.client.permanentFlags.delete("\\Flagged");
	await assert.rejects(
		f.service.manage(f.request({ action: "star" }), f.authorize),
		/permanent/,
	);
	await assert.rejects(
		f.service.manage(
			{ ...f.request({ action: "mark_read" }), uidValidity: "8" },
			f.authorize,
		),
		/UIDVALIDITY/,
	);
	await assert.rejects(
		f.service.manage(
			f.request({ action: "mark_read" }),
			async () => () => false,
		),
		/sender/,
	);
	f.message.flags?.add("\\Draft");
	await assert.rejects(
		f.service.manage(f.request({ action: "mark_read" }), f.authorize),
		/drafts/,
	);
	await assert.rejects(
		f.service.manage(
			{ ...f.request({ action: "mark_read" }), mailbox: "Drafts" },
			f.authorize,
		),
		/Drafts/,
	);
	assert.equal(
		f.client.moves.length + f.client.flagChanges.length + f.client.deletions,
		0,
	);
});

test("policy revocation at final authorization prevents the external write and leaves a discoverable reservation", async (t) => {
	const f = await fixture(t);
	let checks = 0;
	const request = f.request({ action: "star" });
	const record = await f.service.manage(request, async () => {
		if (++checks === 2)
			throw new MailError("POLICY_DENIED", "Revoked", "configure");
		return allowAllMessages;
	});
	assert.equal(record.outcome.status, "uncertain");
	assert.equal(f.client.flagChanges.length, 0);
	assert.equal((await f.service.list(10, 0)).length, 1);
});

test("MOVE capability disappearing during final policy check never invokes a copy/delete fallback", async (t) => {
	const f = await fixture(t);
	let checks = 0;
	const record = await f.service.manage(
		f.request({ action: "archive" }),
		async () => {
			if (++checks === 2) f.client.capabilities.delete("MOVE");
			return allowAllMessages;
		},
	);
	assert.equal(record.outcome.status, "uncertain");
	assert.equal(f.client.moves.length + f.client.deletions, 0);
});

test("label actions use explicit projections and ordinary moves cannot change labels implicitly", async (t) => {
	const f = await fixture(t);
	const applied = await f.service.manage(
		f.request({ action: "apply_label", label: "Labels/Work" }),
		f.authorize,
	);
	assert.equal(applied.outcome.status, "completed");
	assert.equal(f.client.mailboxes.get("INBOX")?.length, 1);
	const labelMessage = f.client.mailboxes.get("Labels/Work")?.[0];
	assert.ok(labelMessage);
	const removed = await f.service.manage(
		{
			...f.request({ action: "remove_label", destination: "Archive" }),
			mailbox: "Labels/Work",
			uid: labelMessage.uid,
		},
		f.authorize,
	);
	assert.equal(removed.outcome.status, "completed");
	assert.equal(f.client.mailboxes.get("Labels/Work")?.length, 0);
	await assert.rejects(
		f.service.manage(
			f.request({ action: "move", destination: "Labels/Work" }),
			f.authorize,
		),
		/apply_label/,
	);
	const mailboxes = await f.client.list();
	assert.throws(
		() =>
			inboxPlan(
				{ ...f.request({ action: "archive" }), mailbox: "Labels/Work" },
				mailboxes,
			),
		/apply_label/,
	);
	assert.throws(
		() =>
			inboxPlan(
				f.request({ action: "move", destination: "Drafts" }),
				mailboxes,
			),
		/outside Drafts/,
	);
});

test("lost MOVE acknowledgment survives restart and reconciles positive placement without another command", async (t) => {
	class LostMove extends FakeImap {
		async messageMove(
			...args: Parameters<FakeImap["messageMove"]>
		): Promise<Awaited<ReturnType<FakeImap["messageMove"]>>> {
			await super.messageMove(...args);
			return false;
		}
	}
	const f = await fixture(t, new LostMove());
	const request = f.request({ action: "archive" });
	assert.equal(
		(await f.service.manage(request, f.authorize)).outcome.status,
		"uncertain",
	);
	const reopened = createInboxService(
		testConfig,
		async (operation) => operation(f.client),
		createInboxStore(testConfig.user, f.directory),
	);
	assert.equal(
		(await reopened.manage(request, f.authorize)).outcome.status,
		"uncertain",
	);
	await assert.rejects(
		reopened.manage(f.request({ action: "star" }), f.authorize),
		/not found/,
	);
	assert.equal(
		(await reopened.reconcile(request.operationId, f.authorize)).outcome.status,
		"completed",
	);
	assert.equal(f.client.moves.length, 1);
	assert.equal(f.client.deletions, 0);
});

test("label reconciliation permits changed source projection UID and refuses duplicate destination evidence", async (t) => {
	class LostLabel extends FakeImap {
		async messageMove(
			...args: Parameters<FakeImap["messageMove"]>
		): Promise<Awaited<ReturnType<FakeImap["messageMove"]>>> {
			await super.messageMove(...args);
			this.mailboxes.set(
				"INBOX",
				(this.mailboxes.get("INBOX") ?? []).map((message) => ({
					...message,
					uid: 88,
				})),
			);
			return false;
		}
	}
	const f = await fixture(t, new LostLabel());
	const request = f.request({ action: "apply_label", label: "Labels/Work" });
	assert.equal(
		(await f.service.manage(request, f.authorize)).outcome.status,
		"uncertain",
	);
	const target = f.client.mailboxes.get("Labels/Work")?.[0];
	assert.ok(target);
	f.client.mailboxes.set("Labels/Work", [target, { ...target, uid: 201 }]);
	assert.equal(
		(await f.service.reconcile(request.operationId, f.authorize)).outcome
			.status,
		"uncertain",
	);
	f.client.mailboxes.set("Labels/Work", [target]);
	assert.equal(
		(await f.service.reconcile(request.operationId, f.authorize)).outcome
			.status,
		"completed",
	);
	assert.equal(f.client.moves.length, 1);
});

test("submitting reservations exclude concurrent mutations through source and label projections and cannot reconcile early", async (t) => {
	const f = await fixture(t);
	f.client.mailboxes.set("Labels/Work", [{ ...f.message, uid: 9 }]);
	let release: () => void = () => {};
	let signal: () => void = () => {};
	const paused = new Promise<void>((resolve) => {
		signal = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let checks = 0;
	const request = f.request({ action: "mark_read" });
	const active = f.service.manage(request, async () => {
		if (++checks === 2) {
			signal();
			await gate;
		}
		return allowAllMessages;
	});
	await paused;
	const other = createInboxService(
		testConfig,
		async (operation) => operation(f.client),
		createInboxStore(testConfig.user, f.directory),
	);
	await assert.rejects(
		other.manage(f.request({ action: "star" }), f.authorize),
		/reserved/,
	);
	await assert.rejects(
		other.manage(
			{ ...f.request({ action: "star" }), mailbox: "Labels/Work", uid: 9 },
			f.authorize,
		),
		/reserved/,
	);
	f.message.flags?.add("\\Seen");
	await assert.rejects(
		other.reconcile(request.operationId, f.authorize),
		/may still be running/,
	);
	release();
	assert.equal((await active).outcome.status, "completed");
	assert.equal(f.client.flagChanges.length, 0);
	assert.equal(
		(await other.manage(f.request({ action: "star" }), f.authorize)).outcome
			.status,
		"completed",
	);
});

test("attempted draft Message-ID cannot evade send claims via a non-draft folder projection", async (t) => {
	const f = await fixture(t);
	const sends = createSendService(testConfig, {
		store: createSendStore(testConfig.user, f.directory),
		submit: async () => ({
			status: "uncertain",
			reason: "Lost SMTP acknowledgement",
		}),
	});
	const operationId = randomUUID();
	const message = newEmailMessage(
		testConfig.user,
		SendEmailSchema.parse({
			operationId,
			to: "recipient@example.com",
			subject: "Test",
			text: "Body",
		}),
	);
	const record = await sends.prepare({
		operationId,
		request: {},
		message,
		source: {
			kind: "draft",
			mailbox: "Drafts",
			uid: 33,
			uidValidity: "7",
			fingerprint: "snapshot",
			draftMessageId: f.message.envelope?.messageId,
		},
	});
	await sends.send(record, message);
	await assert.rejects(
		f.service.manage(f.request({ action: "star" }), f.authorize),
		/reserved/,
	);
	assert.equal(f.client.flagChanges.length, 0);
});

test("journal failure before the claim prevents mutation and terminal completion cannot regress", async (t) => {
	const f = await fixture(t);
	const failed = createInboxService(
		testConfig,
		async (operation) => operation(f.client),
		{
			...f.store,
			claim: async () => {
				throw new MailError("STORAGE_FAILED", "Unavailable", "configure");
			},
		},
	);
	await assert.rejects(
		failed.manage(f.request({ action: "star" }), f.authorize),
		/Unavailable/,
	);
	assert.equal(f.client.flagChanges.length, 0);
	const request = f.request({ action: "star" });
	const record = await f.service.manage(request, f.authorize);
	assert.deepEqual(
		await f.store.uncertain(request.operationId, "Late failure"),
		record,
	);
	assert.equal((await f.store.list(10, 0)).length, 0);
});
