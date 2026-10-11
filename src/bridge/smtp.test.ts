import { strict as assert } from "node:assert";
import { test } from "node:test";
import { simpleParser } from "mailparser";
import type { OutgoingMessage } from "../sending/model.js";
import { smtpFailure, submitEmail } from "./smtp.js";
import { createSmtpTestServer, type SmtpScenario } from "./smtp-test-server.js";
import { testConfig } from "./test-fixtures.js";

const message: OutgoingMessage = {
	from: testConfig.user,
	to: ["recipient@example.com"],
	cc: [],
	bcc: ["hidden@example.com"],
	subject: "Test",
	text: "Reviewed body",
	inReplyTo: ["<parent@example.com>"],
	references: ["<root@example.com>", "<parent@example.com>"],
};

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
			const parsed = await simpleParser(smtp.messages[0]);
			assert.equal(parsed.messageId, "<stable-operation@example.com>");
			assert.equal(parsed.inReplyTo, "<parent@example.com>");
			assert.equal(parsed.bcc, undefined);
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
