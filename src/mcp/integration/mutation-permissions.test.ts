import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { allowAllMessages } from "@/bridge/imap/reading/messages.js";
import { createImapService } from "@/bridge/imap/service.js";
import {
	FakeImap,
	fixtureMessage,
	testConfig,
} from "@/bridge/testing/fixtures.js";
import { createSendService } from "@/mail/sending/service.js";
import { createServer } from "@/mcp/server.js";
import { createDraftStore } from "@/operations/sqlite/drafts.js";
import { createInboxStore } from "@/operations/sqlite/inbox.js";
import { createSendStore } from "@/operations/sqlite/sending.js";
import { createReadPolicy } from "@/policy/schema.js";
import { saveReadPolicy } from "@/policy/store.js";
import {
	READ_ONLY_TOOLS,
	type ToolName,
	ToolNameSchema,
} from "@/policy/tools.js";
import { createTestClient } from "./test-client.js";

const identity = { mailbox: "Drafts", uid: 1, uidValidity: "7" };

async function fixture(t: TestContext) {
	const directory = await mkdtemp(
		join(tmpdir(), "protonmail-dispatch-grants-"),
	);
	t.after(() => rm(directory, { recursive: true, force: true }));
	const policyFile = join(directory, "policy.json");
	const policy = createReadPolicy({
		bridgeUser: testConfig.user,
		allowedMailboxes: ["INBOX", "Drafts", "Archive", "Sent"],
		allowedTools: ToolNameSchema.options,
		inboxWrites: {
			mode: "enabled",
			actions: ["star", "archive"],
			mailboxes: ["INBOX", "Archive"],
		},
	});
	await saveReadPolicy(policy, policyFile);
	const fake = new FakeImap();
	const message = fixtureMessage(1);
	message.flags = new Set();
	fake.mailboxes.set("INBOX", [message]);
	fake.mailboxes.set("Archive", []);
	fake.capabilities.set("MOVE", true);
	const draft = fixtureMessage(1, { sender: testConfig.user });
	draft.source = Buffer.from(
		`From: ${testConfig.user}\r\nTo: recipient@example.com\r\nSubject: Reviewed\r\nMessage-ID: <original@example.com>\r\n\r\nBody`,
	);
	draft.size = draft.source.length;
	fake.mailboxes.set("Drafts", [draft]);
	const drafts = createDraftStore(testConfig.user, directory);
	const inbox = createInboxStore(testConfig.user, directory);
	const sends = createSendStore(testConfig.user, directory);
	const imap = createImapService(testConfig, {
		run: async (operation) => operation(fake),
		draftStore: drafts,
		inboxStore: inbox,
	});
	const revoke = (name: ToolName) =>
		saveReadPolicy(
			{
				...policy,
				allowedTools: policy.allowedTools.filter((tool) => tool !== name),
			},
			policyFile,
		);
	const connect = (
		overrides: {
			imap?: typeof imap;
			sends?: ReturnType<typeof createSendService>;
		} = {},
	) =>
		createTestClient(
			t,
			() =>
				createServer({
					config: testConfig,
					policyFile,
					operationsDirectory: directory,
					imap,
					...overrides,
				}),
			{
				capabilities: { elicitation: { form: {} } },
				onElicitation: async () => ({
					action: "accept",
					content: { approve_send: true },
				}),
			},
		);
	return {
		directory,
		policyFile,
		policy,
		fake,
		drafts,
		inbox,
		sends,
		imap,
		revoke,
		connect,
	};
}

for (const boundary of ["claim", "dispatch"] as const) {
	for (const action of ["star", "archive"] as const) {
		test(`revoking manage_message during ${boundary} blocks ${action} without changing action/mailbox grants`, async (t) => {
			const f = await fixture(t);
			let revoked = false;
			const store = {
				...f.inbox,
				[boundary]: async (
					...args: Parameters<(typeof f.inbox)[typeof boundary]>
				) => {
					// Split the two signatures so each boundary stays correctly typed.
					if (boundary === "claim") {
						const record = args[0];
						assert.ok(typeof record !== "string");
						const result = await f.inbox.claim(record);
						if (!revoked) {
							await f.revoke("manage_message");
							revoked = true;
						}
						return result;
					}
					const id = args[0];
					assert.equal(typeof id, "string");
					if (typeof id !== "string") throw new Error("Expected operation ID");
					const result = await f.inbox.dispatch(id);
					if (!revoked) {
						await f.revoke("manage_message");
						revoked = true;
					}
					return result;
				},
			};
			const imap = createImapService(testConfig, {
				run: async (operation) => operation(f.fake),
				draftStore: f.drafts,
				inboxStore: store,
			});
			const client = await f.connect({ imap });
			const request = {
				operationId: randomUUID(),
				mailbox: "INBOX",
				uid: 1,
				uidValidity: "7",
				change: { action },
			};
			const result = await client.callTool("manage_message", request);
			assert.equal(result.isError, true);
			assert.match(JSON.stringify(result), /manage_message.*disabled/);
			assert.equal(f.fake.flagChanges.length + f.fake.moves.length, 0);
			assert.equal(
				(await f.inbox.get(request.operationId))?.outcome.status,
				"aborted",
			);
			assert.equal(f.fake.flagChanges.length + f.fake.moves.length, 0);
			await saveReadPolicy(f.policy, f.policyFile);
			await client.callTool("manage_message", request);
			assert.equal(f.fake.flagChanges.length + f.fake.moves.length, 0);
			const next = await client.callTool("manage_message", {
				...request,
				operationId: randomUUID(),
			});
			assert.equal(next.isError, false);
			assert.equal(f.fake.flagChanges.length + f.fake.moves.length, 1);
		});
	}
}

test("read-only grants can reconcile an uncertain inbox write without write permissions", async (t) => {
	const f = await fixture(t);
	const add = f.fake.messageFlagsAdd.bind(f.fake);
	f.fake.messageFlagsAdd = async (...args) => {
		await add(...args);
		throw new Error("Lost STORE acknowledgment");
	};
	const client = await f.connect();
	const request = {
		operationId: randomUUID(),
		mailbox: "INBOX",
		uid: 1,
		uidValidity: "7",
		change: { action: "star" },
	};
	await client.callTool("manage_message", request);
	assert.equal(
		(await f.inbox.get(request.operationId))?.outcome.status,
		"uncertain",
	);
	await saveReadPolicy(
		{
			...f.policy,
			allowedTools: READ_ONLY_TOOLS,
			inboxWrites: { mode: "disabled" },
		},
		f.policyFile,
	);
	const result = await client.callTool("reconcile_inbox_operation", {
		operationId: request.operationId,
	});
	assert.equal(result.isError, false);
	assert.equal(
		(await f.inbox.get(request.operationId))?.outcome.status,
		"completed",
	);
	assert.equal(f.fake.flagChanges.length, 1);
	assert.equal(
		f.fake.appends.length + f.fake.deletions + f.fake.moves.length,
		0,
	);
});

for (const tool of ["create_draft", "edit_draft"] as const) {
	test(`revoking ${tool} after its journal claim blocks APPEND and preserves replay protection`, async (t) => {
		const f = await fixture(t);
		let revoked = false;
		const drafts = {
			...f.drafts,
			claim: async (...args: Parameters<typeof f.drafts.claim>) => {
				const result = await f.drafts.claim(...args);
				if (!revoked) {
					await f.revoke(tool);
					revoked = true;
				}
				return result;
			},
		};
		const imap = createImapService(testConfig, {
			run: async (operation) => operation(f.fake),
			draftStore: drafts,
			inboxStore: f.inbox,
		});
		const client = await f.connect({ imap });
		const operationId = randomUUID();
		const request =
			tool === "edit_draft"
				? {
						operationId,
						uid: 1,
						uidValidity: "7",
						expectedRevision: (
							await imap.drafts.read(identity, allowAllMessages)
						).revision,
						text: "Edited",
					}
				: { operationId, text: "New" };
		const result = await client.callTool(tool, request);
		assert.equal(result.isError, true);
		assert.equal(f.fake.appends.length + f.fake.deletions, 0);
		assert.equal((await f.drafts.get(operationId))?.outcome.status, "rejected");
		await saveReadPolicy(f.policy, f.policyFile);
		await client.callTool(tool, request);
		assert.equal(f.fake.appends.length + f.fake.deletions, 0);
		const next = await client.callTool(tool, {
			...request,
			operationId: randomUUID(),
		});
		assert.equal(next.isError, false);
		assert.equal(f.fake.appends.length, 1);
	});
}

test("revoking edit_draft after APPEND retains the original during cleanup", async (t) => {
	const f = await fixture(t);
	const append = f.fake.append.bind(f.fake);
	f.fake.append = async (...args) => {
		const result = await append(...args);
		await f.revoke("edit_draft");
		return result;
	};
	const client = await f.connect();
	const operationId = randomUUID();
	await client.callTool("edit_draft", {
		operationId,
		uid: 1,
		uidValidity: "7",
		expectedRevision: (await f.imap.drafts.read(identity, allowAllMessages))
			.revision,
		text: "Replacement",
	});
	assert.equal(f.fake.appends.length, 1);
	assert.equal(f.fake.deletions, 0);
	assert.equal(
		(await f.drafts.get(operationId))?.outcome.status,
		"cleanup_failed",
	);
});

test("revoking send_email during the durable claim prevents SMTP and records non-submission", async (t) => {
	const f = await fixture(t);
	let submissions = 0;
	const sends = createSendService(testConfig, {
		store: {
			...f.sends,
			claim: async (...args) => {
				const result = await f.sends.claim(...args);
				await f.revoke("send_email");
				return result;
			},
		},
		submit: async () => {
			submissions++;
			return { status: "accepted", accepted: [], rejected: [] };
		},
	});
	const client = await f.connect({ sends });
	const operationId = randomUUID();
	const request = {
		operationId,
		to: "recipient@example.com",
		subject: "Reviewed",
		text: "Body",
	};
	const result = await client.callTool("send_email", request);
	assert.equal(result.isError, true);
	assert.equal(submissions, 0);
	assert.equal((await f.sends.get(operationId))?.outcome.status, "rejected");
	await saveReadPolicy(f.policy, f.policyFile);
	await client.callTool("send_email", request);
	assert.equal(submissions, 0);
});

test("revoking send_draft during snapshot recheck prevents SMTP before claiming submission", async (t) => {
	const f = await fixture(t);
	const fetch = f.fake.fetchOne.bind(f.fake);
	let sourceReads = 0;
	f.fake.fetchOne = async (...args) => {
		const result = await fetch(...args);
		if (args[1].source && ++sourceReads === 2) await f.revoke("send_draft");
		return result;
	};
	let submissions = 0;
	const client = await f.connect({
		sends: createSendService(testConfig, {
			store: f.sends,
			submit: async () => {
				submissions++;
				return { status: "accepted", accepted: [], rejected: [] };
			},
		}),
	});
	const operationId = randomUUID();
	const result = await client.callTool("send_draft", {
		operationId,
		uid: 1,
		uidValidity: "7",
	});
	assert.equal(result.isError, true);
	assert.equal(submissions, 0);
	assert.equal((await f.sends.get(operationId))?.outcome.status, "prepared");
});

test("revoking send_draft after SMTP acceptance prevents deletion without changing acceptance", async (t) => {
	const f = await fixture(t);
	const client = await f.connect({
		sends: createSendService(testConfig, {
			store: f.sends,
			submit: async () => {
				await f.revoke("send_draft");
				return {
					status: "accepted",
					accepted: ["recipient@example.com"],
					rejected: [],
				};
			},
		}),
	});
	const operationId = randomUUID();
	await client.callTool("send_draft", {
		operationId,
		uid: 1,
		uidValidity: "7",
	});
	const record = await f.sends.get(operationId);
	assert.equal(record?.outcome.status, "accepted");
	assert.equal(record?.draftCleanup.status, "failed");
	assert.equal(f.fake.deletions, 0);
});

for (const tool of ["forward_email", "send_draft"] as const) {
	for (const restriction of ["mailbox", "sender"] as const) {
		test(`${tool} rechecks ${restriction} read access after claiming SMTP dispatch`, async (t) => {
			const f = await fixture(t);
			let submissions = 0;
			let revoked = false;
			const mailbox = tool === "forward_email" ? "INBOX" : "Drafts";
			const sends = createSendService(testConfig, {
				store: {
					...f.sends,
					claim: async (...args) => {
						const result = await f.sends.claim(...args);
						if (!revoked) {
							revoked = true;
							await saveReadPolicy(
								{
									...f.policy,
									...(restriction === "mailbox"
										? {
												allowedMailboxes: f.policy.allowedMailboxes.filter(
													(path) => path !== mailbox,
												),
												inboxWrites: { mode: "disabled" },
											}
										: { allowedSenderEmails: ["other@example.com"] }),
								},
								f.policyFile,
							);
						}
						return result;
					},
				},
				submit: async () => {
					submissions++;
					return {
						status: "accepted",
						accepted: ["recipient@example.com"],
						rejected: [],
					};
				},
			});
			const client = await f.connect({ sends });
			const operationId = randomUUID();
			const request =
				tool === "forward_email"
					? {
							operationId,
							source: { mailbox: "INBOX", uid: 1, uidValidity: "7" },
							to: "recipient@example.com",
							text: "Forward",
						}
					: { operationId, uid: 1, uidValidity: "7" };
			const denied = await client.callTool(tool, request);
			assert.equal(denied.isError, true);
			assert.equal(submissions, 0);
			assert.equal(
				(await f.sends.get(operationId))?.outcome.status,
				"rejected",
			);
			await saveReadPolicy(f.policy, f.policyFile);
			await client.callTool(tool, request);
			assert.equal(submissions, 0);
			const next = await client.callTool(tool, {
				...request,
				operationId: randomUUID(),
			});
			assert.equal(next.isError, false);
			assert.equal(submissions, 1);
		});
	}
}

for (const tool of ["retry_draft_cleanup", "retry_send_cleanup"] as const) {
	test(`${tool} rechecks its grant after asynchronous cleanup inspection`, async (t) => {
		const f = await fixture(t);
		let submissions = 0;
		const client = await f.connect({
			sends: createSendService(testConfig, {
				store: f.sends,
				submit: async () => {
					submissions++;
					return {
						status: "accepted",
						accepted: ["recipient@example.com"],
						rejected: [],
					};
				},
			}),
		});
		f.fake.deleteFailure = "throw";
		const operationId = randomUUID();
		if (tool === "retry_draft_cleanup")
			await client.callTool("edit_draft", {
				operationId,
				uid: 1,
				uidValidity: "7",
				expectedRevision: (await f.imap.drafts.read(identity, allowAllMessages))
					.revision,
				text: "Replacement",
			});
		else
			await client.callTool("send_draft", {
				operationId,
				uid: 1,
				uidValidity: "7",
			});
		assert.equal(f.fake.deletions, 1);
		f.fake.deleteFailure = "none";
		const fetch = f.fake.fetchOne.bind(f.fake);
		let revoked = false;
		f.fake.fetchOne = async (...args) => {
			const result = await fetch(...args);
			if (args[1].source && !revoked) {
				revoked = true;
				await f.revoke(tool);
			}
			return result;
		};
		await client.callTool(tool, { operationId });
		assert.equal(f.fake.deletions, 1);
		await saveReadPolicy(f.policy, f.policyFile);
		await client.callTool(tool, { operationId });
		assert.equal(f.fake.deletions, 2);
		assert.equal(submissions, tool === "retry_send_cleanup" ? 1 : 0);
	});
}
