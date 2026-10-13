import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { AttachmentExtension } from "../attachments/formats.js";
import { MAX_ATTACHMENT_BYTES } from "../attachments/limits.js";
import {
	getAttachment,
	getAttachmentMetadata,
	listAttachments,
} from "./attachments.js";
import { allowAllMessages } from "./messages.js";
import { GetAttachmentSchema } from "./schemas.js";
import { FakeImap, fixtureMessage } from "./test-fixtures.js";

const identity = { mailbox: "INBOX", uid: 1, uidValidity: "7" };
const input = GetAttachmentSchema.parse({ ...identity, attachmentId: "2" });

test("attachment reads have no output-format selector", () => {
	for (const format of ["text", "raw", "base64", "pdf", "", null, 1])
		assert.equal(
			GetAttachmentSchema.safeParse({ ...input, format }).success,
			false,
		);
});

function fixture(
	options: {
		filename?: string;
		type?: string;
		size?: number;
		bytes?: Buffer;
		charset?: string;
	} = {},
) {
	const client = new FakeImap();
	const bytes = options.bytes ?? Buffer.from("Attachment text");
	const filename = options.filename ?? "notes.txt";
	const type = options.type ?? "text/plain";
	const message = fixtureMessage(1);
	message.size = 50 * 1024 * 1024; // Inspect one part even when the entire message is large.
	message.bodyStructure = {
		type: "multipart/mixed",
		childNodes: [
			{ part: "1", type: "text/plain", size: 100 },
			{
				part: "2",
				type,
				size: options.size ?? bytes.length,
				disposition: "attachment",
				dispositionParameters: { filename },
				parameters: options.charset ? { charset: options.charset } : undefined,
			},
		],
	};
	client.mailboxes.set("INBOX", [message]);
	client.attachmentContents.set("INBOX:1:2", {
		content: bytes,
		meta: {
			filename,
			contentType: type,
			charset: options.charset,
			disposition: "attachment",
		},
	});
	return client;
}

test("attachment listing reads metadata only; inspection downloads exactly the selected part", async () => {
	const client = fixture();
	const listing = await listAttachments(client, identity, allowAllMessages, [
		".txt",
	]);
	assert.equal(listing.kind, "found");
	if (listing.kind !== "found") return;
	assert.equal(listing.value.attachments.length, 1);
	assert.equal(listing.value.attachments[0]?.attachmentId, "2");
	assert.equal(listing.value.attachments[0]?.inspection.kind, "allowed");
	assert.equal(client.downloads.length, 0);
	assert.equal(client.sourceFetches, 0);
	const result = await getAttachment(client, input, allowAllMessages, {
		allowedExtensions: [".txt"],
	});
	assert.equal(result.kind, "found");
	if (result.kind !== "found" || result.value.status !== "raw") return;
	assert.deepEqual(result.value.bytes, Buffer.from("Attachment text"));
	assert.equal(result.value.untrusted, true);
	assert.equal("text" in result.value, false);
	assert.deepEqual(client.downloads, [
		{ uid: "1", part: "2", maxBytes: MAX_ATTACHMENT_BYTES + 1 },
	]);
});

test("sender refusal, stale identities, disabled extensions, and invalid part IDs never download", async () => {
	const client = fixture();
	assert.equal(
		(await listAttachments(client, identity, () => false, [".txt"])).kind,
		"denied",
	);
	assert.equal(
		(
			await getAttachment(client, input, () => false, {
				allowedExtensions: [".txt"],
			})
		).kind,
		"denied",
	);
	await assert.rejects(
		getAttachment(client, { ...input, uidValidity: "8" }, allowAllMessages, {
			allowedExtensions: [".txt"],
		}),
		/UIDVALIDITY/,
	);
	assert.equal(
		(
			await getAttachment(client, input, allowAllMessages, {
				allowedExtensions: [],
			})
		).kind,
		"unavailable",
	);
	assert.equal(
		(
			await getAttachment(
				client,
				{ ...input, attachmentId: "1" },
				allowAllMessages,
				{ allowedExtensions: [".txt"] },
			)
		).kind,
		"unavailable",
	);
	assert.equal(
		(
			await getAttachment(
				client,
				{ ...input, attachmentId: "99" },
				allowAllMessages,
				{ allowedExtensions: [".txt"] },
			)
		).kind,
		"unavailable",
	);
	assert.equal(client.downloads.length, 0);
	for (const attachmentId of [
		"HEADER",
		"2.MIME",
		"../file.txt",
		"0",
		"2:9",
		"2\r\nUID FETCH",
	])
		assert.equal(
			GetAttachmentSchema.safeParse({ ...input, attachmentId }).success,
			false,
		);
	assert.equal(
		GetAttachmentSchema.safeParse({ ...input, allowedExtensions: [".exe"] })
			.success,
		false,
	);
});

test("unsafe filenames, invalid MIME types, and oversized parts are blocked before download", async () => {
	for (const filename of [
		"../invoice.pdf",
		"C:\\invoice.pdf",
		"notes.txt.exe",
		"notes.txt\0.pdf",
		"notes",
		".txt",
		"notes.pdf ",
		"notes..",
		"notes%00.txt",
		"notes\u202etxt.pdf",
	]) {
		const client = fixture({ filename });
		const result = await getAttachment(client, input, allowAllMessages, {
			allowedExtensions: [".txt", ".pdf"],
		});
		assert.equal(result.kind, "unavailable", filename);
		assert.equal(client.downloads.length, 0, filename);
	}
	for (const client of [
		fixture({ type: "multipart/mixed" }),
		fixture({ type: "not-a-mime-type" }),
		fixture({ size: MAX_ATTACHMENT_BYTES * 2 + 1 }),
	]) {
		assert.equal(
			(
				await getAttachment(client, input, allowAllMessages, {
					allowedExtensions: [".txt"],
				})
			).kind,
			"unavailable",
		);
		assert.equal(client.downloads.length, 0);
	}
	const client = fixture();
	const message = client.mailboxes.get("INBOX")?.[0];
	assert.ok(message?.bodyStructure?.childNodes?.[1]);
	message.bodyStructure.childNodes[1].size = undefined;
	assert.equal(
		(
			await getAttachment(client, input, allowAllMessages, {
				allowedExtensions: [".txt"],
			})
		).kind,
		"unavailable",
	);
	assert.equal(client.downloads.length, 0);
});

test("decoded byte limits and actual part headers are enforced", async () => {
	for (const [filename, type, limit, extension] of [
		["notes.txt", "text/plain", MAX_ATTACHMENT_BYTES, ".txt"],
		["scan.pdf", "application/pdf", MAX_ATTACHMENT_BYTES, ".pdf"],
	] satisfies [string, string, number, AttachmentExtension][]) {
		await assert.rejects(
			getAttachment(
				fixture({ filename, type, bytes: Buffer.alloc(limit + 1), size: 100 }),
				input,
				allowAllMessages,
				{ allowedExtensions: [extension] },
			),
			/download limit/,
		);
	}
	for (const meta of [
		{ filename: "script.exe", contentType: "application/octet-stream" },
		{ filename: "renamed.txt", contentType: "text/plain" },
		{ filename: "notes.txt", contentType: "application/pdf" },
	]) {
		const client = fixture();
		client.attachmentContents.set("INBOX:1:2", {
			content: Buffer.from("payload"),
			meta: { ...meta, disposition: "attachment" },
		});
		await assert.rejects(
			getAttachment(client, input, allowAllMessages, {
				allowedExtensions: [".txt"],
			}),
			/headers/,
		);
	}
});

test("attachment bytes are preserved without decoding, parsing, or text truncation", async () => {
	for (const [extension, type, bytes, charset] of [
		[".txt", "text/plain", Buffer.from([0xff, 0xfe, 0, 65, 0]), "utf-16"],
		[
			".csv",
			"text/csv",
			Buffer.from('=HYPERLINK("https://example.com")\r\n'),
			"windows-1252",
		],
		[".tsv", "text/tab-separated-values", Buffer.from([255, 0, 9]), "utf-16"],
		[
			".md",
			"text/markdown",
			Buffer.from("<script>untrusted</script>"),
			"utf-8",
		],
		[".json", "application/json", Buffer.from("not valid JSON\0"), "utf-8"],
		[".pdf", "application/pdf", Buffer.from("not a valid PDF"), ""],
	] satisfies [AttachmentExtension, string, Buffer, string][]) {
		const result = await getAttachment(
			fixture({
				filename: `FILE${extension.toUpperCase()}`,
				type,
				bytes,
				charset,
			}),
			input,
			allowAllMessages,
			{ allowedExtensions: [extension] },
		);
		assert.equal(result.kind, "found");
		if (result.kind !== "found") continue;
		assert.equal(result.value.status, "raw");
		assert.deepEqual(result.value.bytes, bytes);
		assert.equal("text" in result.value, false);
	}
	const bytes = Buffer.from("a".repeat(100_001));
	const result = await getAttachment(
		fixture({ bytes }),
		input,
		allowAllMessages,
		{ allowedExtensions: [".txt"] },
	);
	assert.equal(result.kind, "found");
	if (result.kind === "found") assert.deepEqual(result.value.bytes, bytes);
});

test("prepared attachment metadata is rechecked before a download", async () => {
	const client = fixture();
	const prepared = await getAttachmentMetadata(
		client,
		input,
		allowAllMessages,
		[".txt"],
	);
	assert.equal(prepared.kind, "found");
	if (prepared.kind !== "found") return;
	assert.equal(client.downloads.length, 0);
	assert.equal(prepared.value.filename, "notes.txt");
	assert.deepEqual(prepared.value.senderEmails, ["trusted@example.com"]);
	const part =
		client.mailboxes.get("INBOX")?.[0]?.bodyStructure?.childNodes?.[1];
	assert.ok(part);
	part.size = 99;
	await assert.rejects(
		getAttachment(client, input, allowAllMessages, {
			allowedExtensions: [".txt"],
			expectedAttachment: prepared.value,
		}),
		/metadata changed/,
	);
	assert.equal(client.downloads.length, 0);
});

test("wildcard permits arbitrary extensions and extensionless files without interpreting bytes or guessing MIME", async () => {
	const bytes = Buffer.from([0, 255, 128, 13, 10, 1]);
	for (const [filename, type] of [
		["photo.png", "image/png"],
		[
			"workbook.xlsx",
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		],
		["bundle.tar.gz", "application/gzip"],
		["program.exe", "application/octet-stream"],
		["forwarded.eml", "message/rfc822"],
		["unknown.数据", "application/x-custom"],
		["LICENSE", "application/octet-stream"],
		["misnamed.pdf", "text/html"],
	]) {
		const client = fixture({ filename, type, bytes });
		const listing = await listAttachments(client, identity, allowAllMessages, [
			"*",
		]);
		assert.equal(listing.kind, "found");
		if (listing.kind !== "found") continue;
		assert.equal(listing.value.attachments[0]?.inspection.kind, "allowed");
		const result = await getAttachment(client, input, allowAllMessages, {
			allowedExtensions: ["*"],
		});
		assert.equal(result.kind, "found", filename);
		if (result.kind !== "found") continue;
		assert.deepEqual(result.value.bytes, bytes);
		assert.equal(result.value.mimeType, type);
		assert.equal(result.value.contentType, type);
	}
	const client = fixture({ filename: "LICENSE", bytes });
	const listing = await listAttachments(client, identity, allowAllMessages, [
		"*",
	]);
	assert.equal(listing.kind, "found");
	if (listing.kind === "found")
		assert.deepEqual(listing.value.attachments[0]?.inspection, {
			kind: "allowed",
			extension: null,
		});
});

test("specific new extensions stay restricted, and wildcard never bypasses filename, MIME, sender or size checks", async () => {
	const client = fixture({ filename: "file.zip", type: "application/zip" });
	assert.equal(
		(
			await getAttachment(client, input, allowAllMessages, {
				allowedExtensions: [".zip"],
			})
		).kind,
		"found",
	);
	assert.equal(
		(
			await getAttachment(client, input, allowAllMessages, {
				allowedExtensions: [".pdf"],
			})
		).kind,
		"unavailable",
	);
	assert.equal(
		(
			await getAttachment(client, input, () => false, {
				allowedExtensions: ["*"],
			})
		).kind,
		"denied",
	);
	for (const unsafe of [
		fixture({ filename: "../file.zip" }),
		fixture({ filename: "file\u202e.zip" }),
		fixture({ type: "multipart/related" }),
		fixture({ type: "application/pdf\r\nX: evil" }),
		fixture({ size: MAX_ATTACHMENT_BYTES * 2 + 1 }),
	]) {
		assert.equal(
			(
				await getAttachment(unsafe, input, allowAllMessages, {
					allowedExtensions: ["*"],
				})
			).kind,
			"unavailable",
		);
		assert.equal(unsafe.downloads.length, 0);
	}
	const bytes = Buffer.alloc(1024 * 1024 + 1);
	const text = await getAttachment(
		fixture({ bytes }),
		input,
		allowAllMessages,
		{ allowedExtensions: [".txt"] },
	);
	assert.equal(text.kind, "found");
	if (text.kind === "found") assert.deepEqual(text.value.bytes, bytes);
});

test("attached messages are listed but their nested attachments are never inspected", async () => {
	const client = fixture();
	const message = client.mailboxes.get("INBOX")?.[0];
	assert.ok(message?.bodyStructure);
	message.bodyStructure.childNodes = [
		{
			part: "2",
			type: "message/rfc822",
			disposition: "attachment",
			size: 100,
			dispositionParameters: { filename: "forwarded.eml" },
			childNodes: [
				{
					part: "2.2",
					type: "text/plain",
					disposition: "attachment",
					dispositionParameters: { filename: "nested.txt" },
					size: 10,
				},
			],
		},
	];
	const result = await listAttachments(client, identity, allowAllMessages, [
		".txt",
	]);
	assert.equal(result.kind, "found");
	if (result.kind !== "found") return;
	assert.deepEqual(
		result.value.attachments.map((item) => item.attachmentId),
		["2"],
	);
	assert.equal(
		(
			await getAttachment(
				client,
				{ ...input, attachmentId: "2.2" },
				allowAllMessages,
				{ allowedExtensions: [".txt"] },
			)
		).kind,
		"unavailable",
	);
	assert.equal(client.downloads.length, 0);
});

test("a standalone attachment uses IMAP part 1 without granting access to ordinary message bodies", async () => {
	const client = fixture();
	const message = client.mailboxes.get("INBOX")?.[0];
	assert.ok(message);
	message.bodyStructure = {
		type: "text/plain",
		disposition: "attachment",
		dispositionParameters: { filename: "standalone.txt" },
		size: 7,
	};
	client.attachmentContents.set("INBOX:1:1", {
		content: Buffer.from("content"),
		meta: {
			filename: "standalone.txt",
			contentType: "text/plain",
			disposition: "attachment",
		},
	});
	const listing = await listAttachments(client, identity, allowAllMessages, [
		".txt",
	]);
	assert.equal(listing.kind, "found");
	if (listing.kind === "found")
		assert.equal(listing.value.attachments[0]?.attachmentId, "1");
	assert.equal(
		(
			await getAttachment(
				client,
				{ ...input, attachmentId: "1" },
				allowAllMessages,
				{ allowedExtensions: [".txt"] },
			)
		).kind,
		"found",
	);
	message.bodyStructure = { type: "text/plain", size: 7 };
	assert.equal(
		(
			await getAttachment(
				client,
				{ ...input, attachmentId: "1" },
				allowAllMessages,
				{ allowedExtensions: [".txt"] },
			)
		).kind,
		"unavailable",
	);
});

test("raw output preserves complete original bytes and the declared MIME type", async () => {
	for (const [filename, mimeType, bytes] of [
		[
			"notes.txt",
			"text/plain",
			Buffer.from(`\ufeff${"é".repeat(100_001)}\r\n`),
		],
		[
			"scan.pdf",
			"application/pdf",
			Buffer.concat([
				Buffer.from("%PDF-1.7\n"),
				Buffer.from([0, 255, 128, 10]),
			]),
		],
	] satisfies [string, string, Buffer][]) {
		const result = await getAttachment(
			fixture({ filename, type: "application/octet-stream", bytes }),
			input,
			allowAllMessages,
			{
				allowedExtensions: [".txt", ".pdf"],
			},
		);
		assert.equal(result.kind, "found");
		if (result.kind !== "found") continue;
		assert.equal(result.value.status, "raw");
		if (result.value.status !== "raw") continue;
		assert.deepEqual(result.value.bytes, bytes);
		assert.equal(result.value.mimeType, "application/octet-stream");
		assert.notEqual(result.value.mimeType, mimeType);
		assert.equal(result.value.contentType, "application/octet-stream");
		assert.equal(result.value.size, bytes.length);
		assert.equal(result.value.untrusted, true);
		assert.equal("text" in result.value, false);
	}
});
