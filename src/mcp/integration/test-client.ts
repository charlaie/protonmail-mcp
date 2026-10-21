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

type TestClientOptions = {
	protocolVersion?: TestProtocolVersion;
	capabilities?: ClientCapabilities;
	onElicitation?: () => Promise<{
		action: "accept" | "decline";
		content?: { approve_send: boolean } | { approve_attachment: boolean };
	}>;
};

type Continuation = {
	inputResponses?: Record<string, unknown>;
	requestState?: string;
};

type SendRequest = (
	method: string,
	params: Record<string, unknown>,
) => Promise<JSONRPCResultResponse>;

const CLIENT_INFO = { name: "regression-test", version: "1" };

const REQUEST_TIMEOUT_MS = 3000;

export async function createTestClient(
	t: TestContext,
	factory: () => McpServer,
	options: TestClientOptions = {},
) {
	const request =
		options.protocolVersion === "2026-07-28"
			? statelessRequestSender(t, factory, options)
			: await sessionRequestSender(t, factory, options);

	return {
		request,
		callTool: async (
			name: string,
			args: object,
			continuation: Continuation = {},
		) =>
			(await request("tools/call", { name, arguments: args, ...continuation }))
				.result,
	};
}

/** 2026-era clients send capabilities and client info with every HTTP request. */
function statelessRequestSender(
	t: TestContext,
	factory: () => McpServer,
	options: TestClientOptions,
): SendRequest {
	const handler = createMcpHandler(factory, { legacy: "reject" });
	t.after(() => handler.close());
	let lastId = 0;

	return async (method, params) => {
		const toolName = typeof params.name === "string" ? params.name : undefined;
		const response = await handler.fetch(
			new Request("http://localhost/mcp", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
					"Mcp-Method": method,
					...(toolName === undefined ? {} : { "Mcp-Name": toolName }),
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: ++lastId,
					method,
					params: {
						...params,
						_meta: {
							[PROTOCOL_VERSION_META_KEY]: "2026-07-28",
							[CLIENT_INFO_META_KEY]: CLIENT_INFO,
							[CLIENT_CAPABILITIES_META_KEY]: options.capabilities ?? {},
						},
					},
				}),
			}),
		);

		const message: unknown = await response.json();
		if (!isJSONRPCResponse(message)) throw new Error(JSON.stringify(message));
		if (isJSONRPCErrorResponse(message)) {
			throw new Error(JSON.stringify(message.error));
		}
		return message;
	};
}

/** 2025-era clients initialize one in-memory session and may answer elicitation requests. */
async function sessionRequestSender(
	t: TestContext,
	factory: () => McpServer,
	options: TestClientOptions,
): Promise<SendRequest> {
	const server = factory();
	const [client, transport] = InMemoryTransport.createLinkedPair();
	t.after(async () => {
		await server.close();
		await client.close();
	});
	await server.connect(transport);
	await client.start();
	let lastId = 0;

	const request: SendRequest = (method, params) => {
		const id = ++lastId;
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(
				() => reject(new Error(`Timed out waiting for ${method}`)),
				REQUEST_TIMEOUT_MS,
			);

			client.onmessage = (message) => {
				const { onElicitation } = options;
				const isElicitation =
					"method" in message &&
					"id" in message &&
					message.method === "elicitation/create";
				if (isElicitation && onElicitation) {
					onElicitation()
						.then((result) =>
							client.send({ jsonrpc: "2.0", id: message.id, result }),
						)
						.catch(reject);
					return;
				}

				if (!isJSONRPCResponse(message) || message.id !== id) return;
				clearTimeout(timeout);
				if (isJSONRPCErrorResponse(message)) {
					reject(new Error(JSON.stringify(message.error)));
				} else {
					resolve(message);
				}
			};

			client.send({ jsonrpc: "2.0", id, method, params }).catch((error) => {
				clearTimeout(timeout);
				reject(error);
			});
		});
	};

	await request("initialize", {
		protocolVersion: options.protocolVersion ?? "2025-11-25",
		capabilities: options.capabilities ?? {},
		clientInfo: CLIENT_INFO,
	});
	await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
	return request;
}
