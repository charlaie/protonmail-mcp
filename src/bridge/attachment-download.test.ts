import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ImapFlow, type MessageStructureObject } from "imapflow";
import type { AttachmentExtension } from "../attachments/formats.js";
import { getAttachment } from "./attachments.js";
import { allowAllMessages } from "./messages.js";
import { GetAttachmentSchema } from "./schemas.js";
import { fixtureMessage } from "./test-fixtures.js";

const input = GetAttachmentSchema.parse({
	mailbox: "INBOX",
	uidValidity: "7",
	uid: 1,
	attachmentId: "2",
});
const readOptions = {
	allowedExtensions: [".txt", ".pdf"] satisfies AttachmentExtension[],
};

function fixture(options: {
	contentType: string;
	filename?: string;
	disposition: "inline" | "attachment" | undefined;
	encoding: "8bit" | "base64";
	bytes?: Buffer;
	charset?: string;
}) {
	const { contentType, disposition, encoding } = options;
	const filename =
		options.filename ??
		(contentType === "application/pdf" ? "scan.pdf" : "notes.txt");
	const original =
		options.bytes ??
		(contentType === "application/pdf"
			? Buffer.concat([
					Buffer.from("%PDF-1.7\n"),
					Buffer.from([0, 255, 128, 10]),
				])
			: Buffer.from("Hello \r\nworld\r\n"));
	const charset = options.charset ?? "utf-8";
	const payload =
		encoding === "base64" ? Buffer.from(original.toString("base64")) : original;
	const parameters: MessageStructureObject["parameters"] =
		contentType === "text/plain"
			? { charset, format: "flowed", delsp: "yes" }
			: {};
	const headers = Buffer.from(
		[
			`Content-Type: ${contentType}; name="${filename}"${contentType === "text/plain" ? `; charset=${charset}; format=flowed; delsp=yes` : ""}`,
			...(disposition
				? [`Content-Disposition: ${disposition}; filename="${filename}"`]
				: []),
			`Content-Transfer-Encoding: ${encoding}`,
			"",
			"",
		].join("\r\n"),
	);
	const message = fixtureMessage(1);
	message.bodyStructure = {
		type: "multipart/mixed",
		childNodes: [
			{
				part: "2",
				type: contentType,
				size: payload.length,
				disposition,
				dispositionParameters: { filename },
				parameters,
			},
		],
	};
	const client = new ImapFlow({
		host: "localhost",
		port: 1143,
		secure: false,
		auth: { user: "fixture", pass: "fixture" },
		logger: false,
	});
	const mailbox = {
		path: "INBOX",
		delimiter: "/",
		flags: new Set<string>(),
		uidValidity: 7n,
		uidNext: 2,
		exists: 1,
	};
	client.mailbox = mailbox;
	client.mailboxOpen = async () => mailbox;
	// Simulate only the network response; MIME parsing and transfer/flow/charset
	// decoding run through the real ImapFlow.download implementation.
	client.fetchOne = async (_range, query) =>
		query.bodyParts
			? {
					...message,
					bodyParts: new Map([
						["2", payload],
						["2.mime", headers],
					]),
				}
			: message;
	return { client, original };
}

test("raw output refuses inline plain text transformed by the real bounded downloader", async () => {
	for (const disposition of ["inline", undefined] satisfies (
		| "inline"
		| undefined
	)[]) {
		const { client, original } = fixture({
			contentType: "text/plain",
			disposition,
			encoding: "8bit",
		});
		const downloaded = await client.download("1", "2", {
			uid: true,
			maxBytes: 100,
		});
		const chunks: Buffer[] = [];
		for await (const chunk of downloaded.content) {
			assert.ok(Buffer.isBuffer(chunk));
			chunks.push(chunk);
		}
		assert.notDeepEqual(Buffer.concat(chunks), original);
		await assert.rejects(
			getAttachment(client, input, allowAllMessages, readOptions),
			/may reformat or transcode/,
		);
	}
});

test("real downloads preserve ordinary text attachments and transfer-decoded inline PDFs", async () => {
	for (const options of [
		{ contentType: "text/plain", disposition: "attachment", encoding: "8bit" },
		{
			contentType: "text/plain",
			disposition: "attachment",
			encoding: "base64",
			bytes: Buffer.from([255, 254, 0, 65, 0, 13, 0, 10]),
			charset: "utf-16",
		},
		{
			contentType: "application/pdf",
			disposition: "inline",
			encoding: "base64",
		},
		{
			contentType: "application/pdf",
			disposition: "attachment",
			encoding: "base64",
		},
	] satisfies Parameters<typeof fixture>[0][]) {
		const { client, original } = fixture(options);
		const result = await getAttachment(
			client,
			input,
			allowAllMessages,
			readOptions,
		);
		assert.equal(result.kind, "found");
		if (result.kind !== "found") continue;
		assert.equal(result.value.status, "raw");
		if (result.value.status === "raw")
			assert.deepEqual(result.value.bytes, original);
	}
});

test("real transfer decoding preserves new binary formats and extensionless files", async () => {
	for (const [filename, contentType] of [
		["photo.png", "image/png"],
		["archive.zip", "application/zip"],
		[
			"document.docx",
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		],
		["forwarded.eml", "message/rfc822"],
		["LICENSE", "application/octet-stream"],
	]) {
		const { client, original } = fixture({
			contentType,
			filename,
			disposition: "attachment",
			encoding: "base64",
			bytes: Buffer.from([0, 255, 128, 13, 10]),
		});
		const result = await getAttachment(client, input, allowAllMessages, {
			allowedExtensions: ["*"],
		});
		assert.equal(result.kind, "found");
		if (result.kind === "found") {
			assert.deepEqual(result.value.bytes, original);
			assert.equal(result.value.mimeType, contentType);
		}
	}
});
