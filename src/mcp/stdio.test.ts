import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
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
import { SearchMessagesSchema, SendEmailSchema } from "../bridge/schemas.js";

test("stdio loads .env, advertises tools, and reports policy errors over the real SDK", {
	timeout: 10_000,
}, async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "protonmail-stdio-"));
	const entry = fileURLToPath(new URL("../index.js", import.meta.url));
	const env = { ...process.env };
	for (const key of Object.keys(env))
		if (key.startsWith("PROTONMAIL_")) delete env[key];
	await writeFile(
		join(directory, ".env"),
		`PROTONMAIL_BRIDGE_USER=fixture@example.com\nPROTONMAIL_BRIDGE_PASSWORD=fixture-password\nPROTONMAIL_MCP_POLICY_FILE=${join(directory, "missing-policy.json")}\n`,
	);
	const child = spawn(process.execPath, [entry], {
		cwd: directory,
		env,
		stdio: "pipe",
	});
	const lines = createInterface({ input: child.stdout });
	let stderr = "";
	child.stderr.on("data", (data) => {
		stderr += data.toString();
	});
	t.after(async () => {
		lines.close();
		child.kill();
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
	assert.equal(listed.result.tools.length, 9);
	const getMessage = listed.result.tools.find(
		(tool) => tool.name === "get_message",
	);
	assert.ok(getMessage);
	assert.ok(getMessage.inputSchema.required?.includes("uidValidity"));
	const getAttachment = listed.result.tools.find(
		(tool) => tool.name === "get_attachment",
	);
	assert.ok(getAttachment);
	assert.ok(getAttachment.inputSchema.required?.includes("uidValidity"));
	assert.ok(getAttachment.inputSchema.required?.includes("attachmentId"));
	assert.equal(getAttachment.inputSchema.required?.includes("format"), false);
	assert.match(
		JSON.stringify(getAttachment.inputSchema.properties?.format),
		/raw/,
	);
	assert.equal(getAttachment.annotations?.readOnlyHint, true);
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
	const invalid = spawnSync(process.execPath, [entry, "bridge:search"], {
		cwd: directory,
		env,
		encoding: "utf8",
	});
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
			to: "person@example.com",
			subject: "Subject\r\nBcc: injected@example.com",
			text: "Body",
		}).success,
		false,
	);
	assert.equal(
		SendEmailSchema.safeParse({
			to: "person@example.com",
			subject: "Subject",
			text: "x".repeat(100_001),
		}).success,
		false,
	);
});
