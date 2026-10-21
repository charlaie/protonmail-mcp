import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isSpecType } from "@modelcontextprotocol/server";
import { z } from "zod";
import { saveReadPolicy } from "../../../policy/store.js";
import { ToolErrorSchema } from "../../../shared/mail-error.js";
import { BINARY_OUTPUT_CAPABILITY } from "./register.js";
import {
	attachmentFixture,
	attachmentIdentity,
	pdfBytes,
} from "./test-fixture.js";

const pendingSchema = z.object({
	resultType: z.literal("input_required"),
	requestState: z.string(),
});
const acceptedResponse = {
	approve_attachment: {
		action: "accept",
		content: { approve_attachment: true },
	},
};
const modernOptions = {
	protocolVersion: "2026-07-28",
	requireApproval: true,
	capabilities: { elicitation: { form: {} } },
} satisfies NonNullable<Parameters<typeof attachmentFixture>[1]>;

function approvedContinuation(pending: { requestState: string }) {
	return {
		requestState: pending.requestState,
		inputResponses: acceptedResponse,
	};
}

function refused(value: unknown) {
	assert.ok(isSpecType.CallToolResult(value));
	assert.ok(value.content);
	assert.equal(value.isError, true);
	assert.equal(
		value.content.some((block) => block.type === "resource"),
		false,
	);
	return ToolErrorSchema.parse(value.structuredContent).error;
}

test("modern approval downloads only after consent, and cannot be replayed", async (t) => {
	const client = await attachmentFixture(t, modernOptions);
	const first = await client.callTool("get_attachment", attachmentIdentity);
	const pending = pendingSchema.parse(first);
	assert.equal(client.imap.downloads.length, 0);
	assert.equal(client.imap.sourceFetches, 0);
	const prompt = JSON.stringify(first);
	assert.match(prompt, /scan.pdf/);
	assert.match(prompt, /trusted@example.com/);
	assert.match(prompt, /transfer_encoded/);
	const result = await client.callTool(
		"get_attachment",
		attachmentIdentity,
		approvedContinuation(pending),
	);
	assert.ok(isSpecType.CallToolResult(result));
	assert.ok(result.content);
	assert.equal(result.isError, undefined);
	const resource = result.content.find((block) => block.type === "resource");
	assert.ok(resource && "blob" in resource.resource);
	assert.deepEqual(Buffer.from(resource.resource.blob, "base64"), pdfBytes);
	assert.equal(client.imap.downloads.length, 1);
	assert.equal(
		refused(
			await client.callTool(
				"get_attachment",
				attachmentIdentity,
				approvedContinuation(pending),
			),
		).code,
		"APPROVAL_DENIED",
	);
	assert.equal(client.imap.downloads.length, 1);
	pendingSchema.parse(
		await client.callTool("get_attachment", attachmentIdentity),
	);
	assert.equal(client.imap.downloads.length, 1);
});

test("wildcard extension grants still require content approval for new binary types", async (t) => {
	const bytes = Buffer.from([0, 255, 128]);
	const client = await attachmentFixture(t, {
		...modernOptions,
		filename: "archive.zip",
		contentType: "application/zip",
		bytes,
		allowedExtensions: ["*"],
	});
	const first = await client.callTool("get_attachment", attachmentIdentity);
	const pending = pendingSchema.parse(first);
	assert.equal(client.imap.downloads.length, 0);
	assert.match(JSON.stringify(first), /archive.zip/);
	assert.match(JSON.stringify(first), /application\/zip/);
	const result = await client.callTool(
		"get_attachment",
		attachmentIdentity,
		approvedContinuation(pending),
	);
	assert.ok(isSpecType.CallToolResult(result));
	assert.equal(result.isError, undefined);
	assert.ok(result.content);
	const resource = result.content.find((block) => block.type === "resource");
	assert.ok(resource && "blob" in resource.resource);
	assert.equal(resource.resource.mimeType, "application/zip");
	assert.deepEqual(Buffer.from(resource.resource.blob, "base64"), bytes);
	assert.equal(client.imap.downloads.length, 1);
});

test("declined, cancelled, unchecked, and forged consent never downloads", async (t) => {
	for (const response of [
		{ action: "decline" },
		{ action: "cancel" },
		{ action: "accept", content: { approve_attachment: false } },
		{ action: "accept", content: {} },
	]) {
		await t.test(JSON.stringify(response), async (t) => {
			const client = await attachmentFixture(t, modernOptions);
			const pending = pendingSchema.parse(
				await client.callTool("get_attachment", attachmentIdentity),
			);
			assert.equal(
				refused(
					await client.callTool("get_attachment", attachmentIdentity, {
						requestState: pending.requestState,
						inputResponses: { approve_attachment: response },
					}),
				).code,
				"APPROVAL_DENIED",
			);
			assert.equal(client.imap.downloads.length, 0);
		});
	}
	const client = await attachmentFixture(t, modernOptions);
	assert.equal(
		refused(
			await client.callTool("get_attachment", attachmentIdentity, {
				inputResponses: acceptedResponse,
			}),
		).code,
		"APPROVAL_DENIED",
	);
	assert.equal(client.imap.downloads.length, 0);
});

test("metadata and policy changes invalidate a pending attachment approval", async (t) => {
	for (const change of ["filename", "size", "subject", "policy"]) {
		await t.test(change, async (t) => {
			const client = await attachmentFixture(t, modernOptions);
			const pending = pendingSchema.parse(
				await client.callTool("get_attachment", attachmentIdentity),
			);
			const part = client.message.bodyStructure?.childNodes?.[0];
			assert.ok(part?.dispositionParameters);
			assert.ok(client.message.envelope);
			switch (change) {
				case "filename":
					part.dispositionParameters.filename = "changed.pdf";
					break;
				case "size":
					part.size = 99;
					break;
				case "subject":
					client.message.envelope.subject = "Changed subject";
					break;
				case "policy":
					await saveReadPolicy(
						{
							...client.policy,
							allowedSenderEmails: ["trusted@example.com"],
						},
						client.policyFile,
					);
					break;
			}
			assert.equal(
				refused(
					await client.callTool(
						"get_attachment",
						attachmentIdentity,
						approvedContinuation(pending),
					),
				).code,
				"APPROVAL_DENIED",
			);
			assert.equal(client.imap.downloads.length, 0);
		});
	}
});

test("approval is bound to the attachment ID and current sender policy", async (t) => {
	const client = await attachmentFixture(t, modernOptions);
	const pending = pendingSchema.parse(
		await client.callTool("get_attachment", attachmentIdentity),
	);
	const part = client.message.bodyStructure?.childNodes?.[0];
	assert.ok(part && client.message.bodyStructure?.childNodes);
	client.message.bodyStructure.childNodes.push({ ...part, part: "3" });
	assert.equal(
		refused(
			await client.callTool(
				"get_attachment",
				{ ...attachmentIdentity, attachmentId: "3" },
				approvedContinuation(pending),
			),
		).code,
		"APPROVAL_DENIED",
	);
	assert.equal(client.imap.downloads.length, 0);
	const next = pendingSchema.parse(
		await client.callTool("get_attachment", attachmentIdentity),
	);
	await saveReadPolicy(
		{
			...client.policy,
			allowedSenderEmails: ["different@example.com"],
		},
		client.policyFile,
	);
	assert.equal(
		refused(
			await client.callTool(
				"get_attachment",
				attachmentIdentity,
				approvedContinuation(next),
			),
		).code,
		"POLICY_DENIED",
	);
	assert.equal(client.imap.downloads.length, 0);
});

test("required approval refuses clients without forms, while metadata listing remains available", async (t) => {
	for (const capabilities of [{}, { elicitation: { url: {} } }]) {
		await t.test(JSON.stringify(capabilities), async (t) => {
			const client = await attachmentFixture(t, {
				requireApproval: true,
				capabilities,
			});
			const listing = await client.callTool("list_attachments", {
				mailbox: attachmentIdentity.mailbox,
				uid: attachmentIdentity.uid,
				uidValidity: attachmentIdentity.uidValidity,
			});
			assert.ok(isSpecType.CallToolResult(listing));
			assert.equal(listing.isError, undefined);
			assert.match(
				refused(await client.callTool("get_attachment", attachmentIdentity))
					.message,
				/form elicitation/,
			);
			assert.equal(client.imap.downloads.length, 0);
		});
	}
});

test("binary incompatibility is refused before requesting attachment approval", async (t) => {
	const client = await attachmentFixture(t, {
		...modernOptions,
		capabilities: {
			elicitation: { form: {} },
			extensions: { [BINARY_OUTPUT_CAPABILITY]: { mimeTypes: [] } },
		},
	});
	assert.equal(
		refused(await client.callTool("get_attachment", attachmentIdentity)).code,
		"UNSUPPORTED_CONTENT",
	);
	assert.equal(client.imap.downloads.length, 0);
});

test("legacy clients approve one attachment, with no contents downloaded before the dialog", async (t) => {
	for (const approve of [true, false]) {
		await t.test(String(approve), async (t) => {
			let downloadsAtPrompt = -1;
			const client = await attachmentFixture(t, {
				requireApproval: true,
				capabilities: { elicitation: { form: {} } },
				onElicitation: async () => {
					downloadsAtPrompt = client.imap.downloads.length;
					return { action: "accept", content: { approve_attachment: approve } };
				},
			});
			const result = await client.call();
			assert.equal(downloadsAtPrompt, 0);
			assert.equal(result.isError === true, !approve);
			assert.equal(client.imap.downloads.length, approve ? 1 : 0);
		});
	}
});

test("legacy approval rechecks policy and attachment metadata before downloading", async (t) => {
	for (const change of ["metadata", "policy", "account"]) {
		await t.test(change, async (t) => {
			const client = await attachmentFixture(t, {
				requireApproval: true,
				capabilities: { elicitation: { form: {} } },
				onElicitation: async () => {
					if (change === "metadata") {
						const part = client.message.bodyStructure?.childNodes?.[0];
						assert.ok(part);
						part.size = 99;
					} else {
						await saveReadPolicy(
							{
								...client.policy,
								...(change === "account"
									? { bridgeUser: "different@example.com" }
									: { allowedAttachmentExtensions: [] }),
							},
							client.policyFile,
						);
					}
					return { action: "accept", content: { approve_attachment: true } };
				},
			});
			refused(await client.call());
			assert.equal(client.imap.downloads.length, 0);
		});
	}
});
