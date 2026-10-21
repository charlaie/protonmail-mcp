import { strict as assert } from "node:assert";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createTestClient } from "@/mcp/integration/test-client.js";
import { jsonResponse } from "./responses.js";
import { ToolRegistry } from "./tool-registry.js";

test("the registry forwards SDK-parsed inputs without applying transformations twice", async (t) => {
	let transformations = 0;
	const client = await createTestClient(t, () => {
		const mcp = new McpServer({ name: "registry-test", version: "1" });
		const tools = new ToolRegistry(mcp, {
			visible: () => true,
			require: async () => {},
		});
		tools.registerTool(
			"get_message",
			{
				inputSchema: z.object({
					value: z.string().transform((value) => {
						transformations++;
						return value.length;
					}),
				}),
				outputSchema: z.object({ value: z.number() }),
			},
			(input) => jsonResponse(input),
		);
		return mcp;
	});
	const result = await client.callTool("get_message", { value: "four" });
	assert.deepEqual(result.structuredContent, { value: 4 });
	assert.equal(transformations, 1);
});
