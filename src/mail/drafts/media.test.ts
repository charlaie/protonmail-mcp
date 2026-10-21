import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { allowAllMessages } from "../../bridge/imap/reading/messages.js";
import { FakeImap, testConfig } from "../../bridge/testing/fixtures.js";
import { createDraftStore } from "../../operations/sqlite/drafts.js";
import { createSendStore } from "../../operations/sqlite/sending.js";
import { testFile, testImage } from "../outgoing/media/test-fixtures.js";
import { createSendService } from "../sending/service.js";
import { permissiveChecks } from "../sending/test-fixtures.js";
import { CreateDraftSchema, EditDraftSchema } from "./requests.js";
import { createDraftService } from "./service.js";
import { allowAllWrites, permissiveDraftChecks } from "./test-fixtures.js";

async function fixture(t: TestContext, client = new FakeImap()) {
	const directory = await mkdtemp(join(tmpdir(), "protonmail-draft-media-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	client.mailboxes.set("Drafts", []);
	const drafts = createDraftService(
		testConfig,
		async (operation) => operation(client),
		createDraftStore(testConfig.user, directory),
	);
	const input = {
		...CreateDraftSchema.parse({
			operationId: randomUUID(),
			to: "recipient@example.com",
			text: "Body < & >",
			attachments: [testFile],
			inlineImages: [testImage],
		}),
		mailbox: "Drafts",
	};
	return { drafts, directory, client, input };
}

test("draft attachment and inline-image bytes survive patch omission and explicit [] independently clears each payload group", async (t) => {
	const { drafts, input } = await fixture(t);
	const created = await drafts.create(input, { authorize: allowAllWrites });
	assert.equal(created.outcome.status, "completed");
	assert.ok("identity" in created.outcome);
	const before = await drafts.read(created.outcome.identity, allowAllMessages);
	assert.equal(before.media.length, 2);
	assert.equal(JSON.stringify(before).includes("contentBase64"), false);
	const patch = {
		...EditDraftSchema.parse({
			operationId: randomUUID(),
			...created.outcome.identity,
			expectedRevision: before.revision,
			subject: "Changed",
		}),
		mailbox: "Drafts",
	};
	const edited = await drafts.edit({
		request: patch,
		mailbox: "Drafts",
		...permissiveDraftChecks,
	});
	assert.ok("identity" in edited.outcome);
	const preserved = await drafts.snapshot(
		edited.outcome.identity,
		allowAllMessages,
	);
	assert.equal(preserved.message.media?.length, 2);
	assert.deepEqual(
		preserved.message.media?.find((part) => part.kind === "attachment")?.file,
		testFile,
	);
	assert.deepEqual(
		preserved.message.media?.find((part) => part.kind === "inline")?.file,
		testImage,
	);
	const clearedFiles = await drafts.edit({
		request: EditDraftSchema.parse({
			operationId: randomUUID(),
			...edited.outcome.identity,
			expectedRevision: preserved.fingerprint,
			attachments: [],
		}),
		mailbox: "Drafts",
		...permissiveDraftChecks,
	});
	assert.ok("identity" in clearedFiles.outcome);
	const inlineOnly = await drafts.snapshot(
		clearedFiles.outcome.identity,
		allowAllMessages,
	);
	assert.equal(inlineOnly.message.media?.length, 1);
	assert.equal(inlineOnly.message.media[0]?.kind, "inline");
	const clearedImages = await drafts.edit({
		request: EditDraftSchema.parse({
			operationId: randomUUID(),
			...clearedFiles.outcome.identity,
			expectedRevision: inlineOnly.fingerprint,
			inlineImages: [],
		}),
		mailbox: "Drafts",
		...permissiveDraftChecks,
	});
	assert.ok("identity" in clearedImages.outcome);
	const plain = await drafts.snapshot(
		clearedImages.outcome.identity,
		allowAllMessages,
	);
	assert.equal(plain.message.media, undefined);
});

test("sending a supported rich draft binds exact files and returns only byte-free manifests in the journal", async (t) => {
	const { drafts, input, directory, client } = await fixture(t);
	const created = await drafts.create(input, { authorize: allowAllWrites });
	assert.ok("identity" in created.outcome);
	const identity = created.outcome.identity;
	const snapshot = await drafts.snapshot(identity, allowAllMessages);
	let submits = 0;
	const sends = createSendService(testConfig, {
		store: createSendStore(testConfig.user, directory),
		submit: async (message) => {
			submits++;
			assert.equal(
				message.media?.find((part) => part.kind === "attachment")?.file
					.contentBase64,
				testFile.contentBase64,
			);
			assert.equal(
				message.media?.find((part) => part.kind === "inline")?.file
					.contentBase64,
				testImage.contentBase64,
			);
			return { status: "accepted", accepted: message.to, rejected: [] };
		},
	});
	const record = await sends.prepare({
		operationId: randomUUID(),
		request: {},
		message: snapshot.message,
		source: {
			kind: "draft",
			...identity,
			fingerprint: snapshot.fingerprint,
			draftMessageId: snapshot.draftMessageId,
		},
	});
	const sent = await sends.send(record, snapshot.message, {
		...permissiveChecks,
		cleanupDraft: () =>
			drafts.deleteSnapshot(
				identity,
				snapshot.fingerprint,
				allowAllMessages,
				allowAllWrites,
			),
	});
	assert.equal(sent.outcome.status, "accepted");
	assert.equal(sent.draftCleanup.status, "deleted");
	assert.equal(sent.media?.length, 2);
	assert.equal(JSON.stringify(sent).includes("contentBase64"), false);
	assert.equal(
		JSON.stringify(created).includes(testImage.contentBase64),
		false,
	);
	await sends.send(record, snapshot.message, permissiveChecks);
	assert.equal(submits, 1);
	assert.equal(client.deletions, 1);
});

test("arbitrary HTML on a supported image draft is refused intact before read, edit or send snapshot", async (t) => {
	const { drafts, input, client } = await fixture(t);
	const created = await drafts.create(input, { authorize: allowAllWrites });
	assert.ok("identity" in created.outcome);
	const identity = created.outcome.identity;
	const before = await drafts.read(identity, allowAllMessages);
	const message = client.mailboxes
		.get("Drafts")
		?.find((candidate) => candidate.uid === identity.uid);
	assert.ok(message?.source);
	message.source = Buffer.from(
		message.source
			.toString()
			.replace("</body>", "<script>alert(1)</script></body>"),
	);
	await assert.rejects(
		drafts.read(identity, allowAllMessages),
		/Arbitrary HTML/,
	);
	await assert.rejects(
		drafts.snapshot(identity, allowAllMessages),
		/Arbitrary HTML/,
	);
	await assert.rejects(
		drafts.edit({
			request: EditDraftSchema.parse({
				operationId: randomUUID(),
				...identity,
				expectedRevision: before.revision,
				text: "Replace",
			}),
			mailbox: "Drafts",
			...permissiveDraftChecks,
		}),
		/Arbitrary HTML/,
	);
	assert.equal(client.appends.length, 1);
	assert.equal(client.deletions, 0);
});

test("uncertain attachment draft recovery accepts transport headers but refuses changed file bytes", async (t) => {
	class LostAppend extends FakeImap {
		async append(...args: Parameters<FakeImap["append"]>): Promise<never> {
			await super.append(...args);
			throw new Error("Acknowledgment lost");
		}
	}
	for (const changed of [false, true])
		await t.test(String(changed), async (t) => {
			const { drafts, input, client } = await fixture(t, new LostAppend());
			assert.equal(
				(await drafts.create(input, { authorize: allowAllWrites })).outcome
					.status,
				"appending",
			);
			const saved = client.mailboxes.get("Drafts")?.[0];
			assert.ok(saved?.source);
			if (changed)
				saved.source = Buffer.from(
					saved.source
						.toString()
						.replace(
							testFile.contentBase64,
							Buffer.from("Changed attachment bytes").toString("base64"),
						),
				);
			else
				saved.source = Buffer.concat([
					Buffer.from("Received: by bridge.local\r\n"),
					saved.source,
				]);
			if (changed)
				await assert.rejects(
					drafts.reconcile(input.operationId, allowAllMessages),
					/different content/,
				);
			else
				assert.equal(
					(await drafts.reconcile(input.operationId, allowAllMessages)).outcome
						.status,
					"completed",
				);
			assert.equal(client.appends.length, 1);
		});
});
