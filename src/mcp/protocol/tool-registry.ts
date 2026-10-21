import type {
	CallToolResult,
	InputRequiredResult,
	McpServer,
	RegisteredTool,
	ServerContext,
} from "@modelcontextprotocol/server";
import type { z } from "zod";
import type { ToolAccess } from "@/policy/access.js";
import type { ToolName } from "@/policy/tools.js";
import { errorResponse } from "./responses.js";

export class ToolRegistry {
	constructor(
		private readonly mcp: McpServer,
		private readonly access: ToolAccess,
	) {}

	get server() {
		return this.mcp.server;
	}

	registerTool<Input, Output>(
		name: ToolName,
		config: Pick<
			RegisteredTool,
			"title" | "description" | "annotations" | "icons" | "_meta"
		> & { inputSchema: z.ZodType<Input>; outputSchema: z.ZodType<Output> },
		handler: (
			input: Input,
			context: ServerContext,
		) =>
			| CallToolResult
			| InputRequiredResult
			| Promise<CallToolResult | InputRequiredResult>,
	) {
		const tool = this.mcp.registerTool(name, config, async (input, context) => {
			try {
				await this.access.require(name);
				return await handler(input, context);
			} catch (error) {
				return errorResponse(error);
			}
		});
		if (!this.access.visible(name)) tool.disable();
		return tool;
	}
}
