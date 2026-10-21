import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { createInterface, type Interface } from "node:readline";
import {
	isJSONRPCErrorResponse,
	isJSONRPCResponse,
	isSpecType,
	type JSONRPCResultResponse,
	parseJSONRPCMessage,
} from "@modelcontextprotocol/server";
import type { LaunchSpecification } from "../clients/configuration.js";

const REQUEST_TIMEOUT_MS = 10_000;

type Request = (
	method: string,
	params?: object,
) => Promise<JSONRPCResultResponse>;

export async function checkMcpStartup(launch: LaunchSpecification) {
	const child = spawn(launch.command, launch.args, {
		cwd: tmpdir(),
		stdio: "pipe",
	});
	const lines = createInterface({ input: child.stdout });
	// Drain diagnostics without putting credentials or arbitrary server logs in reports.
	child.stderr.resume();
	child.stdin.on("error", () => {});
	let startError: Error | undefined;
	child.on("error", (error) => {
		startError = error;
	});
	const request = createRequester(child, lines, () => startError);

	try {
		await request("initialize", {
			protocolVersion: "2025-11-25",
			capabilities: {},
			clientInfo: { name: "protonmail-doctor", version: "1" },
		});
		writeMessage(child, {
			jsonrpc: "2.0",
			method: "notifications/initialized",
		});
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

function createRequester(
	child: ChildProcessWithoutNullStreams,
	lines: Interface,
	startError: () => Error | undefined,
): Request {
	let nextId = 0;

	return (method, params) =>
		new Promise((resolve, reject) => {
			const id = ++nextId;
			const timeout = setTimeout(
				() =>
					fail(
						new Error(`MCP ${method} timed out. Check the client server log.`),
					),
				REQUEST_TIMEOUT_MS,
			);

			function stopListening() {
				clearTimeout(timeout);
				lines.off("line", receive);
				child.off("exit", exited);
				child.off("error", failedToStart);
			}

			function succeed(response: JSONRPCResultResponse) {
				stopListening();
				resolve(response);
			}

			function fail(error: Error) {
				stopListening();
				reject(error);
			}

			function receive(line: string) {
				let response: ReturnType<typeof parseJSONRPCMessage>;
				try {
					response = parseJSONRPCMessage(JSON.parse(line));
				} catch {
					fail(new Error("The server wrote invalid MCP output to stdout."));
					return;
				}
				if (!isJSONRPCResponse(response) || response.id !== id) return;
				if (isJSONRPCErrorResponse(response))
					fail(new Error(`MCP ${method} was rejected.`));
				else succeed(response);
			}

			function exited() {
				fail(
					new Error(
						"The MCP server exited before completing initialization. Check its configuration.",
					),
				);
			}

			function failedToStart(error: Error) {
				fail(new Error(`Could not start the MCP server: ${error.message}`));
			}

			lines.on("line", receive);
			child.once("exit", exited);
			child.once("error", failedToStart);
			const earlierStartError = startError();
			if (earlierStartError) {
				failedToStart(earlierStartError);
				return;
			}
			writeMessage(child, { jsonrpc: "2.0", id, method, params }, (error) => {
				if (error) failedToStart(error);
			});
		});
}

function writeMessage(
	child: ChildProcessWithoutNullStreams,
	message: object,
	onWritten?: (error: Error | null | undefined) => void,
) {
	child.stdin.write(`${JSON.stringify(message)}\n`, onWritten);
}
