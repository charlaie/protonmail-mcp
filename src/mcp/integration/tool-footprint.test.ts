import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isSpecType } from "@modelcontextprotocol/server";
import { testConfig } from "@/bridge/testing/fixtures.js";
import { createServer } from "@/mcp/server.js";
import { createReadPolicy } from "@/policy/schema.js";
import { saveReadPolicy } from "@/policy/store.js";
import { READ_ONLY_TOOLS, ToolNameSchema } from "@/policy/tools.js";
import { createTestClient } from "./test-client.js";

test("tool catalog footprint stays within explicit schema budgets", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "protonmail-tool-footprint-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	for (const [scope, allowedTools] of [
		["all", ToolNameSchema.options],
		["readOnly", READ_ONLY_TOOLS],
		["messageRead", ["search_messages", "get_message"]],
	] as const) {
		const policyFile = join(directory, `${scope}.json`);
		await saveReadPolicy(
			createReadPolicy({
				bridgeUser: testConfig.user,
				allowedMailboxes: ["INBOX"],
				allowedTools: [...allowedTools],
			}),
			policyFile,
		);
		const client = await createTestClient(t, () =>
			createServer({
				config: testConfig,
				policyFile,
				operationsDirectory: join(directory, scope),
			}),
		);
		const response = await client.request("tools/list", {});
		assert.ok(isSpecType.ListToolsResult(response.result));
		const { tools } = response.result;
		const inputDefinitions = tools.map((tool) => ({
			type: "function",
			function: {
				name: tool.name,
				description: tool.description,
				parameters: tool.inputSchema,
			},
		}));
		const size = (value: object) => Buffer.byteLength(JSON.stringify(value));
		const catalogBytes = size(response.result);
		const inputDefinitionBytes = size(inputDefinitions);
		t.diagnostic(
			JSON.stringify({
				scope,
				toolCount: tools.length,
				catalogBytes,
				inputDefinitionBytes,
				outputSchemaBytes: tools.reduce(
					(sum, tool) => sum + size(tool.outputSchema ?? {}),
					0,
				),
			}),
		);
		assert.ok(
			catalogBytes <= 256_000,
			`${scope} catalog exceeds 256 KB; inspect schema expansion`,
		);
		assert.ok(
			inputDefinitionBytes <= 64_000,
			`${scope} input definitions exceed 64 KB`,
		);
	}
});
