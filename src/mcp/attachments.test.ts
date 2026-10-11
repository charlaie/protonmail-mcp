import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import {
	type ClientCapabilities,
	LOG_LEVEL_META_KEY,
	McpServer,
	specTypeSchemas,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { createImapService } from "../bridge/imap.js";
import {
	FakeImap,
	fixtureMessage,
	testConfig,
} from "../bridge/test-fixtures.js";
import { createReadPolicy } from "../policy/schema.js";
import { createReadService } from "../policy/service.js";
import { saveReadPolicy } from "../policy/store.js";
import { ToolErrorSchema } from "../shared/mail-error.js";
import {
	BINARY_OUTPUT_CAPABILITY,
	registerAttachmentTools,
} from "./attachments.js";
import { createTestClient } from "./test-client.js";

const identity = {
	mailbox: "Archive/Invoices",
	uidValidity: "7",
	uid: 1,
	attachmentId: "2",
};
const pdfBytes = Buffer.concat([
	Buffer.from("%PDF-1.7\n"),
	Buffer.from([0, 255, 128, 10]),
]);

async function fixture(
	t: TestContext,
	options: {
		protocolVersion?: "2025-11-25" | "2026-07-28";
		capabilities?: ClientCapabilities;
		text?: boolean;
	} = {},
) {
	const directory = await mkdtemp(join(tmpdir(), "protonmail-raw-mcp-"));
	const previousPath = process.env.PROTONMAIL_MCP_POLICY_FILE;
	process.env.PROTONMAIL_MCP_POLICY_FILE = join(directory, "policy.json");
	const policy = createReadPolicy({
		bridgeUser: testConfig.user,
		allowedMailboxes: [identity.mailbox],
		allowedAttachmentExtensions: [".pdf", ".txt"],
	});
	await saveReadPolicy(policy);
	const imap = new FakeImap();
	const filename = options.text ? "notes.txt" : "scan.pdf";
	const bytes = options.text ? Buffer.from("Attachment text\r\n") : pdfBytes;
	const message = fixtureMessage(1);
	message.bodyStructure = {
		type: "multipart/mixed",
		childNodes: [
			{
				part: "2",
				type: "application/octet-stream",
				size: bytes.length,
				disposition: "attachment",
				dispositionParameters: { filename },
			},
		],
	};
	imap.mailboxes.set(identity.mailbox, [message]);
	imap.attachmentContents.set(`${identity.mailbox}:1:2`, {
		content: bytes,
		meta: { filename, contentType: "application/octet-stream" },
	});
	const service = createImapService(testConfig, async (operation) =>
		operation(imap),
	);
	const factory = () => {
		const server = new McpServer({ name: "attachment-test", version: "1" });
		registerAttachmentTools({
			server,
			readService: () => createReadService(service, testConfig.user),
		});
		return server;
	};
	t.after(async () => {
		if (previousPath === undefined)
			delete process.env.PROTONMAIL_MCP_POLICY_FILE;
		else process.env.PROTONMAIL_MCP_POLICY_FILE = previousPath;
		await rm(directory, { recursive: true, force: true });
	});
	const client = await createTestClient(t, factory, options);
	return {
		imap,
		policy,
		async call(format?: "text" | "raw", metadata?: Record<string, unknown>) {
			const response = await client.request("tools/call", {
				name: "get_attachment",
				...(metadata ? { _meta: metadata } : {}),
				arguments: { ...identity, ...(format ? { format } : {}) },
			});
			const parsed = specTypeSchemas.CallToolResult["~standard"].validate(
				response.result,
			);
			if (parsed.issues) throw new Error(JSON.stringify(parsed.issues));
			return parsed.value;
		},
	};
}

test("raw MCP output is an exact binary resource with unverified client guidance", async (t) => {
	const client = await fixture(t);
	const result = await client.call("raw");
	assert.equal(result.isError, undefined);
	assert.equal(result.content.length, 2);
	const text = result.content.find((block) => block.type === "text");
	assert.ok(text);
	const metadata = z
		.object({
			status: z.literal("raw"),
			clientSupport: z.literal("unverified"),
			untrusted: z.literal(true),
			guidance: z.string(),
			resourceUri: z.string(),
		})
		.parse(JSON.parse(text.text));
	assert.match(metadata.guidance, /format: "text"/);
	assert.equal("bytes" in JSON.parse(text.text), false);
	const resource = result.content.find((block) => block.type === "resource");
	assert.ok(resource && "blob" in resource.resource);
	assert.equal(resource.resource.uri, metadata.resourceUri);
	assert.match(resource.resource.uri, /Archive%2FInvoices\/7\/1\/2$/);
	assert.equal(resource.resource.mimeType, "application/pdf");
	assert.deepEqual(Buffer.from(resource.resource.blob, "base64"), pdfBytes);
	assert.equal(client.imap.downloads.length, 1);
});

for (const protocolVersion of ["2025-11-25", "2026-07-28"] satisfies (
	| "2025-11-25"
	| "2026-07-28"
)[]) {
	test(`${protocolVersion} honors declared binary support and reports explicit refusal`, async (t) => {
		for (const mimeTypes of [["application/pdf"], [], ["image/png"]]) {
			await t.test(JSON.stringify(mimeTypes), async (t) => {
				const declaration = { [BINARY_OUTPUT_CAPABILITY]: { mimeTypes } };
				const client = await fixture(t, {
					protocolVersion,
					capabilities:
						protocolVersion === "2025-11-25"
							? { experimental: declaration }
							: { extensions: declaration },
				});
				const result = await client.call("raw");
				if (mimeTypes.includes("application/pdf")) {
					assert.equal(result.isError, undefined);
					assert.match(JSON.stringify(result.content[0]), /declared/);
					assert.equal(
						result.content.some((block) => block.type === "resource"),
						true,
					);
				} else {
					assert.equal(result.isError, true);
					assert.equal(
						result.content.every((block) => block.type === "text"),
						true,
					);
					assert.match(
						JSON.stringify(result.content),
						/does not declare support for application\/pdf/,
					);
					assert.match(JSON.stringify(result.content), /base64 blob/);
					assert.match(
						ToolErrorSchema.parse(result.structuredContent).error.message,
						/format: "text"/,
					);
				}
			});
		}
	});
}

test("malformed binary declarations return detailed errors, while default text stays unchanged", async (t) => {
	const client = await fixture(t, {
		text: true,
		capabilities: {
			experimental: { [BINARY_OUTPUT_CAPABILITY]: { mimeTypes: [42] } },
		},
	});
	const raw = await client.call("raw");
	assert.equal(raw.isError, true);
	assert.match(
		JSON.stringify(raw.content),
		/Invalid.*binary-output declaration/,
	);
	assert.equal(
		raw.content.some((block) => block.type === "resource"),
		false,
	);
	const text = await client.call();
	assert.equal(text.isError, undefined);
	assert.equal(text.content.length, 1);
	const block = text.content[0];
	assert.ok(block?.type === "text");
	assert.deepEqual(
		z
			.object({
				status: z.literal("ok"),
				text: z.string(),
				truncated: z.boolean(),
			})
			.parse(JSON.parse(block.text)),
		{ status: "ok", text: "Attachment text\r\n", truncated: false },
	);
});

test("binary capability declarations cannot bypass local attachment policy", async (t) => {
	const client = await fixture(t, {
		capabilities: {
			extensions: {
				[BINARY_OUTPUT_CAPABILITY]: { mimeTypes: ["application/pdf"] },
			},
		},
	});
	await saveReadPolicy({ ...client.policy, allowedAttachmentExtensions: [] });
	const result = await client.call("raw");
	assert.equal(result.isError, true);
	assert.match(
		JSON.stringify(result.content),
		/not allowed by the read policy/,
	);
	assert.equal(client.imap.downloads.length, 0);
});

test("legacy log metadata retains initialized binary capabilities", async (t) => {
	const client = await fixture(t, {
		capabilities: {
			experimental: {
				[BINARY_OUTPUT_CAPABILITY]: { mimeTypes: ["application/pdf"] },
			},
		},
	});
	const result = await client.call("raw", { [LOG_LEVEL_META_KEY]: "info" });
	assert.equal(result.isError, undefined);
	assert.equal(
		result.content.some((block) => block.type === "resource"),
		true,
	);
	assert.match(JSON.stringify(result.content[0]), /declared/);
});
