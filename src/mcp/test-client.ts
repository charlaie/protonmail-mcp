import type { TestContext } from "node:test";
import {
	CLIENT_CAPABILITIES_META_KEY,
	CLIENT_INFO_META_KEY,
	type ClientCapabilities,
	createMcpHandler,
	InMemoryTransport,
	isJSONRPCErrorResponse,
	isJSONRPCResponse,
	type JSONRPCResultResponse,
	type McpServer,
	PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";

export type TestProtocolVersion = "2025-11-25" | "2026-07-28";

export async function createTestClient(
	t: TestContext,
	factory: () => McpServer,
	options: {
		protocolVersion?: TestProtocolVersion;
		capabilities?: ClientCapabilities;
		onElicitation?: () => Promise<{
			action: "accept" | "decline";
			content?: { approve_send: boolean };
		}>;
	} = {},
) {
	if (options.protocolVersion === "2026-07-28") {
		const handler = createMcpHandler(factory, { legacy: "reject" });
		t.after(() => handler.close());
		let id = 0;
		async function request(
			method: string,
			params: Record<string, unknown>,
		): Promise<JSONRPCResultResponse> {
			const response = await handler.fetch(
				new Request("http://localhost/mcp", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Accept: "application/json, text/event-stream",
						"Mcp-Method": method,
						...(typeof params.name === "string"
							? { "Mcp-Name": params.name }
							: {}),
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: ++id,
						method,
						params: {
							...params,
							_meta: {
								[PROTOCOL_VERSION_META_KEY]: "2026-07-28",
								[CLIENT_INFO_META_KEY]: {
									name: "regression-test",
									version: "1",
								},
								[CLIENT_CAPABILITIES_META_KEY]: options.capabilities ?? {},
							},
						},
					}),
				}),
			);
			const message: unknown = await response.json();
			if (!isJSONRPCResponse(message)) throw new Error(JSON.stringify(message));
			if (isJSONRPCErrorResponse(message))
				throw new Error(JSON.stringify(message.error));
			return message;
		}
		return {
			request,
			callTool: async (
				name: string,
				args: object,
				continuation: {
					inputResponses?: Record<string, unknown>;
					requestState?: string;
				} = {},
			) =>
				(
					await request("tools/call", {
						name,
						arguments: args,
						...continuation,
					})
				).result,
		};
	}
	const server = factory();
	const [client, transport] = InMemoryTransport.createLinkedPair();
	t.after(async () => {
		await server.close();
		await client.close();
	});
	await server.connect(transport);
	await client.start();
	let nextId = 0;
	const protocolVersion = options.protocolVersion ?? "2025-11-25";
	const capabilities = options.capabilities ?? {};
	async function request(
		method: string,
		params: Record<string, unknown>,
	): Promise<JSONRPCResultResponse> {
		const id = ++nextId;
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(
				() => reject(new Error(`Timed out waiting for ${method}`)),
				3000,
			);
			client.onmessage = (message) => {
				if (
					"method" in message &&
					"id" in message &&
					message.method === "elicitation/create" &&
					options.onElicitation
				) {
					options
						.onElicitation()
						.then((result) =>
							client.send({ jsonrpc: "2.0", id: message.id, result }),
						)
						.catch(reject);
					return;
				}
				if (!isJSONRPCResponse(message) || message.id !== id) return;
				clearTimeout(timeout);
				if (isJSONRPCErrorResponse(message))
					reject(new Error(JSON.stringify(message.error)));
				else resolve(message);
			};
			client
				.send({
					jsonrpc: "2.0",
					id,
					method,
					params,
				})
				.catch((error) => {
					clearTimeout(timeout);
					reject(error);
				});
		});
	}
	if (protocolVersion === "2025-11-25") {
		await request("initialize", {
			protocolVersion,
			capabilities,
			clientInfo: { name: "regression-test", version: "1" },
		});
		await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
	}
	return {
		request,
		callTool: async (
			name: string,
			args: object,
			continuation: {
				inputResponses?: Record<string, unknown>;
				requestState?: string;
			} = {},
		) =>
			(await request("tools/call", { name, arguments: args, ...continuation }))
				.result,
	};
}
