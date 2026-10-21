import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	isJSONRPCErrorResponse,
	isJSONRPCResponse,
	isSpecType,
	type JSONRPCResultResponse,
	parseJSONRPCMessage,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { SearchMessagesSchema } from "@/bridge/imap/reading/requests.js";
import { SendEmailSchema } from "@/mail/sending/requests.js";
import { createReadPolicy } from "@/policy/schema.js";
import { saveReadPolicy } from "@/policy/store.js";
import { ToolNameSchema } from "@/policy/tools.js";
import { ToolErrorSchema } from "@/shared/mail-error.js";

test("stdio loads an explicit JSON config, advertises grants, and checks policy changes over the real SDK", {
	timeout: 10_000,
}, async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "protonmail-stdio-"));
	const entry = fileURLToPath(new URL("../../index.js", import.meta.url));
	const env = { ...process.env };
	for (const key of Object.keys(env))
		if (key.startsWith("PROTONMAIL_")) delete env[key];
	const configPath = join(directory, "config.json");
	const policyFile = join(directory, "policy.json");
	const policy = createReadPolicy({
		bridgeUser: "fixture@example.com",
		allowedMailboxes: ["INBOX"],
		allowedTools: ToolNameSchema.options,
	});
	await saveReadPolicy(policy, policyFile);
	await writeFile(
		configPath,
		JSON.stringify({
			version: 1,
			bridge: { user: "fixture@example.com", password: "fixture-password" },
			storage: {
				policyFile,
				operationsDirectory: join(directory, "operations"),
			},
		}),
	);
	const child = spawn(
		process.execPath,
		[entry, "serve", "--config", configPath],
		{
			cwd: directory,
			env,
			stdio: "pipe",
		},
	);
	const childClosed = once(child, "close");
	const lines = createInterface({ input: child.stdout });
	let stderr = "";
	child.stderr.on("data", (data) => {
		stderr += data.toString();
	});
	t.after(async () => {
		lines.close();
		child.kill();
		await childClosed;
		await rm(directory, { recursive: true, force: true });
	});
	let nextId = 0;
	function request(
		method: string,
		params?: object,
	): Promise<JSONRPCResultResponse> {
		const id = ++nextId;
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				cleanup();
				reject(new Error(`Timed out waiting for ${method}. ${stderr}`));
			}, 3000);
			function cleanup() {
				clearTimeout(timeout);
				lines.off("line", receive);
				child.off("exit", exited);
			}
			function exited() {
				cleanup();
				reject(new Error(`Server exited. ${stderr}`));
			}
			function receive(line: string) {
				try {
					const message = parseJSONRPCMessage(JSON.parse(line));
					if (!isJSONRPCResponse(message) || message.id !== id) return;
					cleanup();
					if (isJSONRPCErrorResponse(message))
						reject(new Error(message.error.message));
					else resolve(message);
				} catch (error) {
					cleanup();
					reject(error);
				}
			}
			lines.on("line", receive);
			child.once("exit", exited);
			child.stdin.write(
				`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
			);
		});
	}
	await request("initialize", {
		protocolVersion: "2025-11-25",
		capabilities: {},
		clientInfo: { name: "regression-test", version: "1" },
	});
	child.stdin.write(
		`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
	);
	const listed = await request("tools/list");
	assert.ok(isSpecType.ListToolsResult(listed.result));
	const tools = listed.result.tools;
	assert.deepEqual(
		listed.result.tools.map((tool) => tool.name).sort(),
		[
			"create_draft",
			"create_mailbox",
			"create_reply_draft",
			"edit_draft",
			"forward_email",
			"get_attachment",
			"get_draft",
			"get_draft_operation",
			"get_inbox_capabilities",
			"get_inbox_operation",
			"get_message",
			"get_send_operation",
			"get_thread",
			"list_attachments",
			"list_draft_operations",
			"list_inbox_operations",
			"list_mailboxes",
			"list_send_operations",
			"manage_message",
			"reconcile_draft_operation",
			"reconcile_inbox_operation",
			"reconcile_send_operation",
			"retry_draft_cleanup",
			"retry_send_cleanup",
			"search_messages",
			"send_draft",
			"send_email",
		].sort(),
	);
	assert.ok(listed.result.tools.every((tool) => tool.outputSchema));
	for (const name of [
		"create_draft",
		"create_reply_draft",
		"forward_email",
		"manage_message",
	]) {
		const advertised: (typeof tools)[number] | undefined = tools.find(
			(candidate) => candidate.name === name,
		);
		assert.ok(advertised);
		assert.ok(advertised.inputSchema.required?.includes("operationId"));
		assert.equal(advertised.annotations?.idempotentHint, true);
	}
	const editDraft = listed.result.tools.find(
		(tool) => tool.name === "edit_draft",
	);
	assert.ok(editDraft);
	const editVariants = z
		.array(z.object({ required: z.array(z.string()) }))
		.parse(editDraft.inputSchema.anyOf);
	assert.equal(editVariants.length, 2);
	assert.ok(
		editVariants.every(
			(variant) =>
				variant.required.includes("operationId") &&
				variant.required.includes("expectedRevision"),
		),
	);
	assert.ok(
		editVariants.some((variant) => variant.required.includes("draftId")),
	);
	assert.ok(
		editVariants.some(
			(variant) =>
				variant.required.includes("uid") &&
				variant.required.includes("uidValidity"),
		),
	);
	assert.ok(
		editVariants.every(
			(variant) =>
				!variant.required.includes("text") &&
				!variant.required.includes("subject"),
		),
	);
	assert.equal(editDraft.annotations?.idempotentHint, true);
	const getDraft = listed.result.tools.find(
		(tool) => tool.name === "get_draft",
	);
	assert.equal(getDraft?.annotations?.readOnlyHint, true);
	for (const name of ["retry_draft_cleanup", "retry_send_cleanup"]) {
		const advertised: (typeof tools)[number] | undefined = tools.find(
			(candidate) => candidate.name === name,
		);
		assert.equal(advertised?.annotations?.destructiveHint, true);
	}
	const getMessage = listed.result.tools.find(
		(tool) => tool.name === "get_message",
	);
	assert.ok(getMessage);
	assert.ok(getMessage.outputSchema);
	assert.ok(getMessage.inputSchema.required?.includes("uidValidity"));
	const getAttachment = listed.result.tools.find(
		(tool) => tool.name === "get_attachment",
	);
	assert.ok(getAttachment);
	assert.ok(getAttachment.inputSchema.required?.includes("uidValidity"));
	assert.ok(getAttachment.inputSchema.required?.includes("attachmentId"));
	assert.equal(getAttachment.inputSchema.required?.includes("format"), false);
	assert.equal(getAttachment.inputSchema.properties?.format, undefined);
	assert.equal(getAttachment.annotations?.readOnlyHint, true);
	await rm(policyFile);
	for (const name of ["list_attachments", "get_attachment"]) {
		const result = await request("tools/call", {
			name,
			arguments: {
				mailbox: "INBOX",
				uid: 1,
				uidValidity: "7",
				...(name === "get_attachment" ? { attachmentId: "2" } : {}),
			},
		});
		assert.ok(isSpecType.CallToolResult(result.result));
		assert.equal(result.result.isError, true);
		assert.match(JSON.stringify(result.result.content), /setup/);
	}
	const denied = await request("tools/call", {
		name: "search_messages",
		arguments: { mailbox: "INBOX" },
	});
	assert.ok(isSpecType.CallToolResult(denied.result));
	assert.equal(denied.result.isError, true);
	assert.ok(JSON.stringify(denied.result.content).includes("setup"));
	assert.equal(
		ToolErrorSchema.parse(denied.result.structuredContent).error.code,
		"POLICY_NOT_CONFIGURED",
	);
	const invalidFormat = await request("tools/call", {
		name: "get_attachment",
		arguments: {
			mailbox: "INBOX",
			uid: 1,
			uidValidity: "7",
			attachmentId: "2",
			format: "base64",
		},
	});
	assert.ok(isSpecType.CallToolResult(invalidFormat.result));
	assert.equal(invalidFormat.result.isError, true);
	assert.match(JSON.stringify(invalidFormat.result.content), /format/);
	await saveReadPolicy(policy, policyFile);
	const invalid = spawnSync(
		process.execPath,
		[entry, "bridge:search", "--config", configPath],
		{
			cwd: directory,
			env,
			encoding: "utf8",
		},
	);
	assert.equal(invalid.status, 1);
	assert.ok(invalid.stderr.includes("mailbox"));
	const help = spawnSync(process.execPath, [entry, "--help"], {
		cwd: directory,
		env,
		encoding: "utf8",
	});
	assert.equal(help.status, 0);
	assert.ok(help.stdout.includes("bridge:search <mailbox> [query]"));
});

test("schemas reject invalid date ranges and unsafe headers before contacting Bridge", () => {
	assert.equal(
		SearchMessagesSchema.safeParse({
			mailbox: "INBOX",
			since: "2026-10-05",
			before: "2026-10-05",
		}).success,
		false,
	);
	assert.equal(
		SendEmailSchema.safeParse({
			operationId: "bca519ee-fd56-480a-9b47-d1d90d9fa1c7",
			to: "person@example.com",
			subject: "Subject\r\nBcc: injected@example.com",
			text: "Body",
		}).success,
		false,
	);
	assert.equal(
		SendEmailSchema.safeParse({
			operationId: "bca519ee-fd56-480a-9b47-d1d90d9fa1c7",
			to: "person@example.com",
			subject: "Subject",
			text: "x".repeat(100_001),
		}).success,
		false,
	);
});
