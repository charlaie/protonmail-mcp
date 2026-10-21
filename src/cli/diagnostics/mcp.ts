import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import {
	isJSONRPCErrorResponse,
	isJSONRPCResponse,
	isSpecType,
	type JSONRPCResultResponse,
	parseJSONRPCMessage,
} from "@modelcontextprotocol/server";
import type { LaunchSpecification } from "@/cli/clients/configuration.js";

export async function checkMcpStartup(launch: LaunchSpecification) {
	const child = spawn(launch.command, launch.args, {
		cwd: tmpdir(),
		stdio: "pipe",
	});
	const lines = createInterface({ input: child.stdout });
	// Drain diagnostics without putting credentials or arbitrary server logs in reports.
	child.stderr.resume();
	child.stdin.on("error", () => {});
	let processError: Error | undefined;
	child.on("error", (error) => {
		processError = error;
	});
	let nextId = 0;
	function request(
		method: string,
		params?: object,
	): Promise<JSONRPCResultResponse> {
		return new Promise((resolve, reject) => {
			const id = ++nextId;
			const timeout = setTimeout(
				() =>
					finish(
						new Error(`MCP ${method} timed out. Check the client server log.`),
					),
				10_000,
			);
			function finish(error: Error | null, result?: JSONRPCResultResponse) {
				clearTimeout(timeout);
				lines.off("line", receive);
				child.off("exit", exited);
				child.off("error", failed);
				if (error) reject(error);
				else if (result) resolve(result);
			}
			function receive(line: string) {
				try {
					const response = parseJSONRPCMessage(JSON.parse(line));
					if (!isJSONRPCResponse(response) || response.id !== id) return;
					if (isJSONRPCErrorResponse(response))
						finish(new Error(`MCP ${method} was rejected.`));
					else finish(null, response);
				} catch {
					finish(new Error("The server wrote invalid MCP output to stdout."));
				}
			}
			function exited() {
				finish(
					new Error(
						"The MCP server exited before completing initialization. Check its configuration.",
					),
				);
			}
			function failed(error: Error) {
				finish(new Error(`Could not start the MCP server: ${error.message}`));
			}
			lines.on("line", receive);
			child.once("exit", exited);
			child.once("error", failed);
			if (processError) {
				failed(processError);
				return;
			}
			child.stdin.write(
				`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
				(error) => {
					if (error) failed(error);
				},
			);
		});
	}
	try {
		await request("initialize", {
			protocolVersion: "2025-11-25",
			capabilities: {},
			clientInfo: { name: "protonmail-doctor", version: "1" },
		});
		child.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
		);
		const response = await request("tools/list");
		if (!isSpecType.ListToolsResult(response.result))
			throw new Error("The MCP tool list has an invalid format.");
		return `${response.result.tools.length} tools advertised; startup works outside the repository directory.`;
	} finally {
		lines.close();
		child.stdin.destroy();
		child.kill();
	}
}
