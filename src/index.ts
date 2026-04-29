#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadBridgeConfig } from "./bridge/config.js";
import { createServer } from "./mcp/server.js";
import { safeErrorMessage } from "./shared/errors.js";

async function main() {
	loadBridgeConfig();

	const server = createServer();
	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error("Protonmail MCP Server running on stdio");
}

main().catch((error) => {
	console.error("Fatal error in main():", safeErrorMessage(error));
	process.exit(1);
});
