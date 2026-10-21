import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { simpleParser } from "mailparser";
import { testConfig } from "../../../bridge/testing/fixtures.js";
import { composeDraft } from "../../drafts/composition/compose.js";
import { CreateDraftSchema, EditDraftSchema } from "../../drafts/requests.js";
import { draftContentHash } from "../../drafts/snapshots.js";
import { newEmailMessage, sendContentHash } from "../../sending/model.js";
import { SendEmailSchema } from "../../sending/requests.js";
import { inlineHtml, parsedMedia, verifyComposedMedia } from "./mime.js";
import {
	AttachmentPayloadSchema,
	fileDigest,
	InlineImagePayloadSchema,
	MAX_FILE_BYTES,
	MAX_MEDIA_BYTES,
	mediaManifest,
	outgoingMedia,
} from "./model.js";
import {
	testFile as file,
	testImage as png,
	testGif,
	testJpeg,
} from "./test-fixtures.js";

test("payload boundary rejects unsafe filenames, noncanonical base64, excessive sizes and path/URL arguments", () => {
	for (const filename of [
		"../report.pdf",
		"dir/file.pdf",
		"report\n.pdf",
		"bad\\file.pdf",
		"https:evil.pdf",
		"file\u202e.pdf",
		" report.pdf",
		".hidden",
	])
		assert.equal(
			AttachmentPayloadSchema.safeParse({ ...file, filename }).success,
			false,
		);
	for (const contentBase64 of [
		"YQ",
		"YQ=",
		"YR==",
		"YQ==\n",
		"data:application/pdf;base64,YQ==",
	])
		assert.equal(
			AttachmentPayloadSchema.safeParse({ ...file, contentBase64 }).success,
			false,
		);
	assert.equal(
		AttachmentPayloadSchema.safeParse({ ...file, path: "/etc/passwd" }).success,
		false,
	);
	assert.equal(
		AttachmentPayloadSchema.safeParse({
			...file,
			href: "https://example.com/file",
		}).success,
		false,
	);
	assert.equal(
		AttachmentPayloadSchema.safeParse({
			...file,
			contentType: "application/pdf\r\nX: evil",
		}).success,
		false,
	);
	assert.equal(
		AttachmentPayloadSchema.safeParse({
			...file,
			contentBase64: Buffer.alloc(MAX_FILE_BYTES + 1).toString("base64"),
		}).success,
		false,
	);
	const tooLarge = {
		...file,
		contentBase64: Buffer.alloc(MAX_MEDIA_BYTES / 2 + 1).toString("base64"),
	};
	assert.equal(
		CreateDraftSchema.safeParse({
			operationId: randomUUID(),
			attachments: [tooLarge, tooLarge],
		}).success,
		false,
	);
	assert.equal(
		CreateDraftSchema.safeParse({
			operationId: randomUUID(),
			attachments: Array.from({ length: 21 }, () => file),
		}).success,
		false,
	);
	assert.equal(
		AttachmentPayloadSchema.parse({ ...file, contentBase64: "" }).contentBase64,
		"",
	);
});

test("inline images validate signature, MIME and dimensions before generating escaped CID markup", () => {
	assert.equal(InlineImagePayloadSchema.safeParse(png).success, true);
	for (const invalid of [
		{ ...png, contentType: "image/jpeg" },
		{ ...png, contentType: "image/svg+xml" },
		{ ...png, contentBase64: "" },
		{
			...png,
			contentBase64: Buffer.from("<script>alert(1)</script>").toString(
				"base64",
			),
		},
	])
		assert.equal(InlineImagePayloadSchema.safeParse(invalid).success, false);
	const dimensions = Buffer.from(png.contentBase64, "base64");
	dimensions.writeUInt32BE(100_000, 16);
	assert.equal(
		InlineImagePayloadSchema.safeParse({
			...png,
			contentBase64: dimensions.toString("base64"),
		}).success,
		false,
	);
	const media = outgoingMedia({ inlineImages: [png, png] });
	assert.equal(mediaManifest(media)[0]?.sha256, fileDigest(png));
	const html = inlineHtml('<script> & "x"\r\n世界', media);
	assert.ok(html);
	assert.match(html, /&lt;script&gt; &amp; &quot;x&quot;<br>世界/);
	assert.equal(html.includes("<script>"), false);
	assert.ok(media[0]?.kind === "inline" && media[1]?.kind === "inline");
	assert.notEqual(media[0].cid, media[1].cid);
	assert.equal(html.includes("data:"), false);
	assert.equal(html.includes(png.contentBase64), false);
});

test("multipart attachments are refused and a MIME parser losing media cannot authorize APPEND", async () => {
	for (const contentType of [
		"multipart/mixed",
		"multipart/alternative",
		"multipart/related",
	]) {
		const attachment = { ...file, contentType };
		assert.equal(AttachmentPayloadSchema.safeParse(attachment).success, false);
		assert.equal(
			CreateDraftSchema.safeParse({
				operationId: randomUUID(),
				attachments: [attachment],
			}).success,
			false,
		);
		assert.equal(
			SendEmailSchema.safeParse({
				operationId: randomUUID(),
				to: "recipient@example.com",
				subject: "File",
				text: "Body",
				attachments: [attachment],
			}).success,
			false,
		);
	}
	const malformed = await simpleParser(
		[
			"Content-Type: multipart/mixed; boundary=outer",
			"MIME-Version: 1.0",
			"",
			"--outer",
			"Content-Type: text/plain",
			"",
			"Body",
			"--outer",
			"Content-Type: multipart/mixed",
			`Content-Disposition: attachment; filename="${file.filename}"`,
			"Content-Transfer-Encoding: base64",
			"",
			file.contentBase64,
			"--outer--",
		].join("\r\n"),
		{ skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true },
	);
	assert.deepEqual(parsedMedia(malformed), []);
	assert.throws(
		() =>
			verifyComposedMedia(malformed, outgoingMedia({ attachments: [file] })),
		/did not preserve every file/,
	);
});

test("attachment/inline MIME roundtrip preserves exact bytes, filename, MIME and generated body for empty, Unicode and CRLF text", async () => {
	for (const text of [
		"",
		"  Leading/trailing spaces  ",
		'Hello <script>\r\n世界 & "quotes"',
	]) {
		const input = {
			...CreateDraftSchema.parse({
				operationId: randomUUID(),
				text,
				attachments: [
					file,
					{
						filename: "empty.txt",
						contentType: "text/plain",
						contentBase64: "",
					},
				],
				inlineImages: [png],
			}),
			mailbox: "Drafts",
		};
		const draft = await composeDraft(testConfig, {
			kind: "create",
			input: input,
		});
		assert.match(draft.content.toString(), /Content-Type: text\/plain/);
		const original = await simpleParser(draft.content, {
			skipImageLinks: true,
			skipHtmlToText: true,
			skipTextToHtml: true,
		});
		const parts = parsedMedia(original);
		assert.deepEqual(mediaManifest(parts), draft.media);
		assert.equal(original.text ?? "", text.replace(/\r\n/g, "\n"));
		assert.ok(typeof original.html === "string");
		assert.equal(original.html.trim(), inlineHtml(original.text ?? "", parts));
		const pdf = original.attachments.find(
			(attachment) => attachment.filename === file.filename,
		);
		assert.ok(pdf);
		assert.equal(pdf.contentType, file.contentType);
		assert.deepEqual(pdf.content, Buffer.from(file.contentBase64, "base64"));
		assert.equal(
			original.attachments.find(
				(attachment) => attachment.filename === "empty.txt",
			)?.content.length,
			0,
		);
		const changed = await simpleParser(draft.content, {
			skipImageLinks: true,
			skipHtmlToText: true,
			skipTextToHtml: true,
		});
		const image = changed.attachments.find(
			(part) => part.filename === png.filename,
		);
		assert.ok(image);
		image.content = Buffer.from("Changed bytes");
		assert.throws(() => draftContentHash(changed));
	}
});

test("media changes bind send hashes while no-media message shape remains compatible", () => {
	const input = SendEmailSchema.parse({
		operationId: randomUUID(),
		to: "recipient@example.com",
		subject: "Report",
		text: "Body",
		attachments: [file],
		inlineImages: [png],
	});
	const original = newEmailMessage(testConfig.user, input);
	const changed = newEmailMessage(testConfig.user, {
		...input,
		attachments: [
			{ ...file, contentBase64: Buffer.from("Changed").toString("base64") },
		],
	});
	assert.notEqual(
		sendContentHash(original, { kind: "email" }),
		sendContentHash(changed, { kind: "email" }),
	);
	const plain = newEmailMessage(testConfig.user, {
		...input,
		attachments: [],
		inlineImages: [],
	});
	assert.equal("media" in plain, false);
	const patch = EditDraftSchema.parse({
		operationId: randomUUID(),
		uid: 1,
		uidValidity: "7",
		expectedRevision: "0".repeat(64),
		text: "New",
	});
	assert.equal("attachments" in patch, false);
	assert.equal("inlineImages" in patch, false);
});

test("draft attachment parsing preserves declared octet-stream and non-UTF-8 charset independently of filename inference", async () => {
	const files = [
		{
			filename: "binary.txt",
			contentType: "application/octet-stream",
			contentBase64: Buffer.from([0, 0xff, 0x80]).toString("base64"),
		},
		{
			filename: "legacy.txt",
			contentType: "text/plain",
			charset: "windows-1252",
			contentBase64: Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString("base64"),
		},
	];
	const draft = await composeDraft(testConfig, {
		kind: "create",
		input: {
			...CreateDraftSchema.parse({
				operationId: randomUUID(),
				attachments: files,
			}),
			mailbox: "Drafts",
		},
	});
	const parsed = await simpleParser(draft.content, {
		skipImageLinks: true,
		skipHtmlToText: true,
		skipTextToHtml: true,
	});
	assert.deepEqual(
		parsedMedia(parsed).map((part) => part.file),
		files,
	);
	assert.equal(draft.media[0]?.contentType, "application/octet-stream");
	assert.ok(draft.media[1]?.kind === "attachment");
	assert.equal(draft.media[1].charset, "windows-1252");
	const header = parsed.attachments[1]?.headers.get("content-type");
	assert.ok(header && typeof header === "object" && "params" in header);
	const original = parsed.attachments[1];
	assert.ok(original);
	original.headers.set("content-type", {
		value: "text/plain",
		params: { name: "legacy.txt", charset: "windows-1252", format: "flowed" },
	});
	assert.throws(() => parsedMedia(parsed), /MIME parameters are unsupported/);
});

test("JPEG and GIF inline files pass independent format readers, while malformed JPEG segment lengths are refused", async () => {
	for (const image of [testJpeg, testGif]) {
		assert.equal(InlineImagePayloadSchema.safeParse(image).success, true);
		const draft = await composeDraft(testConfig, {
			kind: "create",
			input: {
				...CreateDraftSchema.parse({
					operationId: randomUUID(),
					text: "Image",
					inlineImages: [image],
				}),
				mailbox: "Drafts",
			},
		});
		const parsed = await simpleParser(draft.content, {
			skipImageLinks: true,
			skipHtmlToText: true,
			skipTextToHtml: true,
		});
		assert.deepEqual(parsedMedia(parsed)[0]?.file, image);
	}
	const malformed = Buffer.from(testJpeg.contentBase64, "base64");
	malformed.writeUInt16BE(65_535, 4);
	assert.equal(
		InlineImagePayloadSchema.safeParse({
			...testJpeg,
			contentBase64: malformed.toString("base64"),
		}).success,
		false,
	);
});
