import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { testConfig } from "../../bridge/testing/fixtures.js";
import { sendOperationResponse } from "../../mcp/tools/sending/register.js";
import { SendOutputSchema } from "../../mcp/tools/sending/schemas.js";
import { createSendStore } from "../../operations/sqlite/sending.js";
import type { OutgoingMessage } from "../outgoing/message.js";
import type { SmtpOutcome } from "./model.js";
import { createSendService } from "./service.js";

const message: OutgoingMessage = {
	from: testConfig.user,
	to: ["recipient@example.com"],
	cc: [],
	bcc: ["hidden@example.com"],
	subject: "Reviewed subject",
	text: "Reviewed body",
	inReplyTo: ["<parent@example.com>"],
	references: ["<root@example.com>", "<parent@example.com>"],
};
const accepted: SmtpOutcome = {
	status: "accepted",
	accepted: ["recipient@example.com", "hidden@example.com"],
	rejected: [],
};
async function directory(t: TestContext) {
	const path = await mkdtemp(join(tmpdir(), "protonmail-send-journal-"));
	t.after(() => rm(path, { recursive: true, force: true }));
	return path;
}

test("concurrent requests and a new server instance submit a send operation only once", async (t) => {
	const path = await directory(t);
	let attempts = 0;
	const submit = async () => {
		attempts++;
		return accepted;
	};
	const one = createSendService(testConfig, {
		store: createSendStore(testConfig.user, path),
		submit,
	});
	const two = createSendService(testConfig, {
		store: createSendStore(testConfig.user, path),
		submit,
	});
	const operationId = randomUUID();
	const request = { operationId, kind: "email", message };
	const record = await one.prepare({
		operationId,
		request,
		message,
		source: { kind: "email" },
	});
	assert.match(record.messageId, new RegExp(operationId));
	await Promise.all([one.send(record, message), two.send(record, message)]);
	assert.equal(attempts, 1);
	const reopened = createSendService(testConfig, {
		store: createSendStore(testConfig.user, path),
		submit,
	});
	assert.equal((await reopened.get(operationId)).outcome.status, "accepted");
	await reopened.send(record, message);
	assert.equal(attempts, 1);
	if (process.platform !== "win32")
		assert.equal(
			(await stat(createSendStore(testConfig.user, path).path)).mode & 0o777,
			0o600,
		);
	await assert.rejects(
		reopened.prepare({
			operationId,
			request,
			message: { ...message, text: "Changed" },
			source: { kind: "email" },
		}),
		/different request or draft snapshot/,
	);
	await assert.rejects(
		createSendService(
			{ ...testConfig, user: "other@example.com" },
			{ store: createSendStore("other@example.com", path) },
		).get(operationId),
		/not found/,
	);
});

test("a process exiting after the durable claim leaves an uncertain operation that cannot resend", async (t) => {
	const path = await directory(t);
	const store = createSendStore(testConfig.user, path);
	const service = createSendService(testConfig, {
		store,
		submit: async () => {
			throw new Error("Must not submit");
		},
	});
	const operationId = randomUUID();
	const record = await service.prepare({
		operationId,
		request: { operationId },
		message,
		source: { kind: "email" },
	});
	const child = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`import { createSendStore } from ${JSON.stringify(new URL("../../operations/sqlite/sending.js", import.meta.url).href)}; const store = createSendStore(${JSON.stringify(testConfig.user)}, ${JSON.stringify(path)}); const record = await store.get(${JSON.stringify(operationId)}); if (!await store.claim(record.operationId, record.contentHash)) process.exit(2); process.exit(0);`,
		],
		{ encoding: "utf8" },
	);
	assert.equal(child.status, 0, child.stderr);
	const pending = await service.get(operationId);
	assert.equal(pending.outcome.status, "submitting");
	const publicResult = SendOutputSchema.parse(
		sendOperationResponse(pending).structuredContent,
	);
	assert.ok("outcome" in publicResult);
	assert.equal(publicResult.outcome.status, "uncertain");
	assert.equal(
		(await service.send(record, message)).outcome.status,
		"submitting",
	);
	assert.equal(
		(await service.reconcile(operationId, async () => [])).outcome.status,
		"submitting",
	);
	const reconciled = await service.reconcile(operationId, async () => [
		{ mailbox: "Sent", uid: 12, uidValidity: "7" },
	]);
	assert.equal(reconciled.outcome.status, "submitting");
	assert.deepEqual(reconciled.sentCopies, [
		{ mailbox: "Sent", uid: 12, uidValidity: "7" },
	]);
});

test("SMTP acceptance is durable before cleanup, while failures and partial sends retain drafts", async (t) => {
	const path = await directory(t);
	for (const outcome of [
		accepted,
		{
			status: "partially_accepted",
			accepted: ["recipient@example.com"],
			rejected: ["hidden@example.com"],
		},
		{ status: "uncertain", reason: "Connection lost after DATA" },
	] satisfies SmtpOutcome[]) {
		const store = createSendStore(testConfig.user, path);
		const service = createSendService(testConfig, {
			store,
			submit: async () => outcome,
		});
		const operationId = randomUUID();
		const record = await service.prepare({
			operationId,
			request: { operationId },
			message,
			source: {
				kind: "draft",
				mailbox: "Drafts",
				uid:
					outcome.status === "accepted"
						? 1
						: outcome.status === "partially_accepted"
							? 2
							: 3,
				uidValidity: "7",
				fingerprint: "snapshot",
			},
		});
		let cleaned = 0;
		const result = await service.send(record, message, {
			cleanup: async () => {
				cleaned++;
				assert.equal(
					(await service.get(operationId)).outcome.status,
					"accepted",
				);
				throw new Error("Deletion failed");
			},
		});
		assert.equal(result.outcome.status, outcome.status);
		assert.equal(cleaned, outcome.status === "accepted" ? 1 : 0);
		assert.equal(
			result.draftCleanup.status,
			outcome.status === "accepted" ? "failed" : "retained",
		);
		await service.send(record, message);
		assert.equal(cleaned, outcome.status === "accepted" ? 1 : 0);
	}
});

test("an unavailable or corrupt journal refuses sending before SMTP", async (t) => {
	const path = await directory(t);
	const store = createSendStore(testConfig.user, path);
	await writeFile(store.path, "corrupt database");
	const service = createSendService(testConfig, {
		store,
		submit: async () => {
			throw new Error("Must not submit");
		},
	});
	await assert.rejects(
		service.prepare({
			operationId: randomUUID(),
			request: {},
			message,
			source: { kind: "email" },
		}),
		/journal could not be accessed/,
	);
});

test("different operation IDs cannot submit the same draft through separate server instances", async (t) => {
	const path = await directory(t);
	let attempts = 0;
	const submit = async (): Promise<SmtpOutcome> => {
		attempts++;
		return { status: "uncertain", reason: "Lost acknowledgment" };
	};
	const first = createSendService(testConfig, {
		store: createSendStore(testConfig.user, path),
		submit,
	});
	const second = createSendService(testConfig, {
		store: createSendStore(testConfig.user, path),
		submit,
	});
	const source = {
		kind: "draft" as const,
		mailbox: "Drafts",
		uid: 1,
		uidValidity: "7",
		fingerprint: "same-draft",
	};
	const one = await first.prepare({
		operationId: randomUUID(),
		request: {},
		message,
		source,
	});
	const two = await second.prepare({
		operationId: randomUUID(),
		request: {},
		message,
		source,
	});
	const results = await Promise.allSettled([
		first.send(one, message),
		second.send(two, message),
	]);
	assert.equal(attempts, 1);
	assert.equal(
		results.filter((result) => result.status === "rejected").length,
		1,
	);
});

test("failure to persist an SMTP outcome leaves the durable claim and prevents another attempt", async (t) => {
	const path = await directory(t);
	const store = createSendStore(testConfig.user, path);
	let attempts = 0;
	const service = createSendService(testConfig, {
		store: {
			...store,
			finish: async () => {
				throw new Error("Disk unavailable");
			},
		},
		submit: async () => {
			attempts++;
			return accepted;
		},
	});
	const record = await service.prepare({
		operationId: randomUUID(),
		request: {},
		message,
		source: { kind: "email" },
	});
	assert.equal(
		(await service.send(record, message)).outcome.status,
		"uncertain",
	);
	assert.equal(
		(await store.get(record.operationId))?.outcome.status,
		"submitting",
	);
	await service.send(record, message);
	assert.equal(attempts, 1);
});

test("Sent reconciliation overlapping SMTP completion preserves both transport outcome and evidence", async (t) => {
	const path = await directory(t);
	for (const outcome of [
		accepted,
		{
			status: "partially_accepted",
			accepted: ["recipient@example.com"],
			rejected: ["hidden@example.com"],
		},
		{ status: "rejected", reason: "DATA rejected" },
	] satisfies SmtpOutcome[]) {
		await t.test(outcome.status, async () => {
			let complete: (outcome: SmtpOutcome) => void = () => {};
			let started: () => void = () => {};
			const submitting = new Promise<void>((resolve) => {
				started = resolve;
			});
			const store = createSendStore(testConfig.user, path);
			const service = createSendService(testConfig, {
				store,
				submit: () => {
					started();
					return new Promise<SmtpOutcome>((resolve) => {
						complete = resolve;
					});
				},
			});
			const record = await service.prepare({
				operationId: randomUUID(),
				request: {},
				message,
				source: { kind: "email" },
			});
			const sending = service.send(record, message);
			await submitting;
			const matches = [{ mailbox: "Sent", uid: 12, uidValidity: "7" }];
			const observed = await service.reconcile(
				record.operationId,
				async () => matches,
			);
			assert.equal(observed.outcome.status, "submitting");
			complete(outcome);
			const result = await sending;
			assert.deepEqual(result.outcome, outcome);
			assert.deepEqual(result.sentCopies, matches);
			assert.deepEqual(
				(await service.get(record.operationId)).outcome,
				outcome,
			);
		});
	}
});

test("accepted-draft cleanup retries never submit SMTP and deleted remains terminal under a delayed failure", async (t) => {
	const path = await directory(t);
	let submits = 0;
	const store = createSendStore(testConfig.user, path);
	const service = createSendService(testConfig, {
		store,
		submit: async () => {
			submits++;
			return accepted;
		},
	});
	const record = await service.prepare({
		operationId: randomUUID(),
		request: {},
		message,
		source: {
			kind: "draft",
			mailbox: "Drafts",
			uid: 1,
			uidValidity: "7",
			fingerprint: "original",
		},
	});
	const sent = await service.send(record, message, {
		cleanup: async () => ({
			status: "failed",
			reason: "Disconnected",
		}),
	});
	assert.equal(sent.outcome.status, "accepted");
	let fail: () => void = () => {};
	let started: () => void = () => {};
	const pending = new Promise<void>((resolve) => {
		started = resolve;
	});
	const retry = service.retryCleanup(record.operationId, async () => {
		started();
		await new Promise<void>((resolve) => {
			fail = resolve;
		});
		return { status: "failed", reason: "Late failure" };
	});
	await pending;
	const cleaned = await service.retryCleanup(
		record.operationId,
		async (source) => {
			assert.equal(source.fingerprint, "original");
			return { status: "deleted" };
		},
	);
	assert.equal(cleaned.draftCleanup.status, "deleted");
	fail();
	assert.equal((await retry).draftCleanup.status, "deleted");
	assert.equal(
		(
			await service.retryCleanup(record.operationId, async () => {
				throw new Error("Must not delete twice");
			})
		).draftCleanup.status,
		"deleted",
	);
	assert.equal(submits, 1);
});

test("cleanup-only retry refuses prepared, uncertain and partial submissions without deleting or submitting", async (t) => {
	const path = await directory(t);
	for (const status of [
		"prepared",
		"uncertain",
		"partially_accepted",
	] as const) {
		const service = createSendService(testConfig, {
			store: createSendStore(testConfig.user, path),
			submit: async () =>
				status === "partially_accepted"
					? {
							status,
							accepted: ["recipient@example.com"],
							rejected: ["hidden@example.com"],
						}
					: { status: "uncertain", reason: "Interrupted" },
		});
		const record = await service.prepare({
			operationId: randomUUID(),
			request: {},
			message,
			source: {
				kind: "draft",
				mailbox: "Drafts",
				uid: status === "uncertain" ? 2 : 3,
				uidValidity: "7",
				fingerprint: "original",
			},
		});
		if (status !== "prepared") await service.send(record, message);
		await assert.rejects(
			service.retryCleanup(record.operationId, async () => {
				throw new Error("Must not delete");
			}),
			/Cleanup requires a fully accepted draft send/,
		);
	}
});
