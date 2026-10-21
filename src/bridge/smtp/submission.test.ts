import { strict as assert } from "node:assert";
import { test } from "node:test";
import { simpleParser } from "mailparser";
import { testConfig } from "@/bridge/testing/fixtures.js";
import {
	createSmtpTestServer,
	type SmtpScenario,
} from "@/bridge/testing/smtp-server.js";
import { outgoingMedia } from "@/mail/outgoing/media/model.js";
import { testFile, testImage } from "@/mail/outgoing/media/test-fixtures.js";
import type { OutgoingMessage } from "@/mail/outgoing/message.js";
import {
	smtpFailure,
	submitEmail,
	verifySmtpConnection,
} from "./submission.js";

const message: OutgoingMessage = {
	from: testConfig.user,
	to: ["recipient@example.com"],
	cc: [],
	bcc: ["hidden@example.com"],
	subject: "Test",
	text: "Reviewed body",
	media: outgoingMedia({ attachments: [testFile], inlineImages: [testImage] }),
	inReplyTo: ["<parent@example.com>"],
	references: ["<root@example.com>", "<parent@example.com>"],
};

test("SMTP diagnostics authenticate using STARTTLS without sending any message", async (t) => {
	const smtp = await createSmtpTestServer(t, "accepted");
	assert.equal(
		await verifySmtpConnection({ ...testConfig, smtpPort: smtp.port }),
		true,
	);
	assert.deepEqual(smtp.messages, []);
});

test("SMTP uses the selected alias in both From and the envelope", async (t) => {
	const smtp = await createSmtpTestServer(t, "accepted");
	const alias = "work@example.com";
	const result = await submitEmail(
		{ ...testConfig, smtpPort: smtp.port },
		{ ...message, from: alias },
		"<alias-operation@example.com>",
	);
	assert.equal(result.status, "accepted");
	const [source] = smtp.messages;
	assert.ok(source);
	const parsed = await simpleParser(source);
	assert.equal(parsed.from?.value[0]?.address, alias);
	assert.deepEqual(smtp.mailFrom, [`MAIL FROM:<${alias}>`]);
});

for (const scenario of [
	"accepted",
	"partial",
	"reject_envelope",
	"reject_data",
	"drop_after_data",
] satisfies SmtpScenario[]) {
	test(`real SMTP with STARTTLS reports ${scenario} without exposing Bcc`, {
		timeout: 10_000,
	}, async (t) => {
		const smtp = await createSmtpTestServer(t, scenario);
		const outcome = await submitEmail(
			{ ...testConfig, smtpPort: smtp.port },
			message,
			"<stable-operation@example.com>",
		);
		assert.equal(
			outcome.status,
			scenario === "accepted"
				? "accepted"
				: scenario === "partial"
					? "partially_accepted"
					: scenario === "drop_after_data"
						? "uncertain"
						: "rejected",
		);
		if (scenario === "accepted" || scenario === "partial") {
			assert.ok("accepted" in outcome);
			assert.equal(
				outcome.accepted.includes("hidden@example.com"),
				scenario === "accepted",
			);
			assert.equal(
				outcome.rejected.includes("hidden@example.com"),
				scenario === "partial",
			);
			const [source] = smtp.messages;
			assert.ok(source);
			const parsed = await simpleParser(source, {
				skipImageLinks: true,
			});
			assert.equal(parsed.messageId, "<stable-operation@example.com>");
			assert.equal(parsed.inReplyTo, "<parent@example.com>");
			assert.equal(parsed.bcc, undefined);
			const file = parsed.attachments.find(
				(attachment) => attachment.filename === testFile.filename,
			);
			assert.ok(file);
			assert.equal(file.contentType, testFile.contentType);
			assert.deepEqual(
				file.content,
				Buffer.from(testFile.contentBase64, "base64"),
			);
			const image = parsed.attachments.find(
				(attachment) => attachment.filename === testImage.filename,
			);
			assert.ok(image?.cid);
			assert.deepEqual(
				image.content,
				Buffer.from(testImage.contentBase64, "base64"),
			);
			assert.ok(typeof parsed.html === "string");
			assert.ok(parsed.html.includes(`cid:${image.cid}`));
		}
	});
}

test("a CONN socket error cannot establish that SMTP did not accept DATA", () => {
	assert.equal(
		smtpFailure({
			code: "ECONNECTION",
			command: "CONN",
			message: "Connection closed",
		}).status,
		"uncertain",
	);
	assert.equal(
		smtpFailure({ code: "EAUTH", command: "AUTH PLAIN", responseCode: 535 })
			.status,
		"rejected",
	);
});
