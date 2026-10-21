import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isSpecType, LOG_LEVEL_META_KEY } from "@modelcontextprotocol/server";
import { z } from "zod";
import { saveReadPolicy } from "@/policy/store.js";
import { ToolErrorSchema } from "@/shared/mail-error.js";
import { BINARY_OUTPUT_CAPABILITY } from "./register.js";
import { AttachmentListOutputSchema } from "./schemas.js";
import {
	attachmentIdentity,
	attachmentFixture as fixture,
	pdfBytes,
} from "./test-fixture.js";

test("raw MCP output is an exact binary resource with unverified client guidance", async (t) => {
	const client = await fixture(t);
	const result = await client.call();
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
	assert.match(metadata.guidance, /save or process/);
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
				const result = await client.call();
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
					assert.equal(client.imap.downloads.length, 0);
					assert.match(
						ToolErrorSchema.parse(result.structuredContent).error.message,
						/save or process/,
					);
				}
			});
		}
	});
}

test("malformed binary declarations are rejected before content download", async (t) => {
	const client = await fixture(t, {
		text: true,
		capabilities: {
			experimental: { [BINARY_OUTPUT_CAPABILITY]: { mimeTypes: [42] } },
		},
	});
	const result = await client.call();
	assert.equal(result.isError, true);
	assert.match(
		JSON.stringify(result.content),
		/Invalid.*binary-output declaration/,
	);
	assert.equal(
		result.content.some((block) => block.type === "resource"),
		false,
	);
	assert.equal(client.imap.downloads.length, 0);
});

test("get_attachment always returns bytes and rejects removed format arguments", async (t) => {
	const client = await fixture(t, { text: true });
	const result = await client.call();
	assert.equal(result.isError, undefined);
	const resource = result.content.find((block) => block.type === "resource");
	assert.ok(resource && "blob" in resource.resource);
	assert.deepEqual(Buffer.from(resource.resource.blob, "base64"), client.bytes);
	for (const format of ["text", "raw"]) {
		const refused = await client.callTool("get_attachment", {
			...attachmentIdentity,
			format,
		});
		assert.ok(isSpecType.CallToolResult(refused));
		assert.equal(refused.isError, true);
	}
	assert.equal(client.imap.downloads.length, 1);
});

test("binary capability declarations cannot bypass local attachment policy", async (t) => {
	const client = await fixture(t, {
		capabilities: {
			extensions: {
				[BINARY_OUTPUT_CAPABILITY]: { mimeTypes: ["application/pdf"] },
			},
		},
	});
	await saveReadPolicy(
		{ ...client.policy, allowedAttachmentExtensions: [] },
		client.policyFile,
	);
	const result = await client.call();
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
	const result = await client.call({ [LOG_LEVEL_META_KEY]: "info" });
	assert.equal(result.isError, undefined);
	assert.equal(
		result.content.some((block) => block.type === "resource"),
		true,
	);
	assert.match(JSON.stringify(result.content[0]), /declared/);
});

test("wildcard attachment policy delivers arbitrary types with their declared MIME and supports extensionless listing", async (t) => {
	for (const [filename, contentType] of [
		["archive.zip", "application/zip"],
		["photo.png", "image/png"],
		["misnamed.pdf", "application/octet-stream"],
		["LICENSE", "application/octet-stream"],
	]) {
		const bytes = Buffer.from([0, 255, 128, 13, 10]);
		const client = await fixture(t, {
			filename,
			contentType,
			bytes,
			allowedExtensions: ["*"],
			capabilities: {
				extensions: {
					[BINARY_OUTPUT_CAPABILITY]: { mimeTypes: [contentType] },
				},
			},
		});
		const listing = AttachmentListOutputSchema.parse(
			(await client.callTool("list_attachments", attachmentIdentity))
				.structuredContent,
		);
		assert.ok("attachments" in listing);
		assert.equal(listing.attachments[0]?.inspection.kind, "allowed");
		const result = await client.call();
		assert.equal(result.isError, undefined);
		const resource = result.content.find((block) => block.type === "resource");
		assert.ok(resource && "blob" in resource.resource);
		assert.equal(resource.resource.mimeType, contentType);
		assert.deepEqual(Buffer.from(resource.resource.blob, "base64"), bytes);
	}
	const client = await fixture(t, {
		filename: "misnamed.pdf",
		contentType: "application/octet-stream",
		allowedExtensions: ["*"],
		capabilities: {
			extensions: {
				[BINARY_OUTPUT_CAPABILITY]: { mimeTypes: ["application/pdf"] },
			},
		},
	});
	const refused = await client.call();
	assert.equal(refused.isError, true);
	assert.match(
		JSON.stringify(refused.content),
		/does not declare support for application\/octet-stream/,
	);
	assert.equal(client.imap.downloads.length, 0);
});
