import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { specTypeSchemas } from "@modelcontextprotocol/server";
import type { AttachmentPermission } from "../attachments/formats.js";
import { createImapService } from "../bridge/imap.js";
import {
	FakeImap,
	fixtureMessage,
	testConfig,
} from "../bridge/test-fixtures.js";
import { createReadPolicy } from "../policy/schema.js";
import { saveReadPolicy } from "../policy/store.js";
import { ToolNameSchema } from "../policy/tools.js";
import { createApprovalController } from "./elicitation.js";
import { createServer } from "./server.js";
import { createTestClient } from "./test-client.js";

export const attachmentIdentity = {
	mailbox: "Archive/Invoices",
	uidValidity: "7",
	uid: 1,
	attachmentId: "2",
};
export const pdfBytes = Buffer.concat([
	Buffer.from("%PDF-1.7\n"),
	Buffer.from([0, 255, 128, 10]),
]);

export async function attachmentFixture(
	t: TestContext,
	options: NonNullable<Parameters<typeof createTestClient>[2]> & {
		text?: boolean;
		requireApproval?: boolean;
		filename?: string;
		contentType?: string;
		bytes?: Buffer;
		allowedExtensions?: AttachmentPermission[];
	} = {},
) {
	const directory = await mkdtemp(join(tmpdir(), "protonmail-attachment-mcp-"));
	const policyFile = join(directory, "policy.json");
	const policy = createReadPolicy({
		bridgeUser: testConfig.user,
		allowedTools: ToolNameSchema.options,
		allowedMailboxes: [attachmentIdentity.mailbox],
		allowedAttachmentExtensions: options.allowedExtensions ?? [".pdf", ".txt"],
		requireAttachmentApproval: options.requireApproval,
	});
	await saveReadPolicy(policy, policyFile);
	const imap = new FakeImap();
	const filename =
		options.filename ?? (options.text ? "notes.txt" : "scan.pdf");
	const bytes =
		options.bytes ??
		(options.text ? Buffer.from([255, 254, 0, 65, 0, 13, 10]) : pdfBytes);
	const contentType =
		options.contentType ?? (options.text ? "text/plain" : "application/pdf");
	const message = fixtureMessage(1);
	message.bodyStructure = {
		type: "multipart/mixed",
		childNodes: [
			{
				part: "2",
				type: contentType,
				size: bytes.length,
				disposition: "attachment",
				dispositionParameters: { filename },
			},
		],
	};
	imap.mailboxes.set(attachmentIdentity.mailbox, [message]);
	imap.attachmentContents.set(`${attachmentIdentity.mailbox}:1:2`, {
		content: bytes,
		meta: { filename, contentType, disposition: "attachment" },
	});
	const service = createImapService(testConfig, async (operation) =>
		operation(imap),
	);
	const approval = createApprovalController();
	const factory = () =>
		createServer({
			config: testConfig,
			policyFile,
			operationsDirectory: directory,
			imap: service,
			approval,
		});
	t.after(async () => {
		await rm(directory, { recursive: true, force: true });
	});
	const client = await createTestClient(t, factory, options);
	return {
		...client,
		imap,
		message,
		bytes,
		policy,
		policyFile,
		approval,
		async call(metadata?: Record<string, unknown>) {
			const response = await client.request("tools/call", {
				name: "get_attachment",
				...(metadata ? { _meta: metadata } : {}),
				arguments: attachmentIdentity,
			});
			const parsed = specTypeSchemas.CallToolResult["~standard"].validate(
				response.result,
			);
			if (parsed.issues) throw new Error(JSON.stringify(parsed.issues));
			return parsed.value;
		},
	};
}
