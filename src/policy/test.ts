#!/usr/bin/env node

import { strict as assert } from "node:assert";
import { messageSummary } from "../bridge/imap/serializers.js";
import type { MessageSummary } from "../mail/message.js";
import { canReadMailbox, canReadMessage } from "./enforcement.js";
import { createReadPolicy } from "./schema.js";

function fixtureMessage(from: string[]): MessageSummary {
	return messageSummary(
		{
			uid: 1,
			seq: 1,
			size: 100,
			envelope: {
				from: from.map((address) => ({
					address: address.match(/<([^>]+)>$/)?.[1] ?? address,
				})),
			},
		},
		"7",
	);
}

function runPolicyChecks() {
	const policy = createReadPolicy({
		bridgeUser: "bridge@example.com",
		allowedMailboxes: ["INBOX"],
		allowedSenderEmails: ["trusted@example.com"],
		allowedSenderDomains: ["partner.test"],
	});

	assert.equal(canReadMailbox(policy, "INBOX"), true);
	assert.equal(canReadMailbox(policy, "Archive"), false);
	assert.equal(
		canReadMessage(policy, {
			mailbox: "INBOX",
			message: fixtureMessage(["Trusted <trusted@example.com>"]),
		}),
		true,
	);
	assert.equal(
		canReadMessage(policy, {
			mailbox: "INBOX",
			message: fixtureMessage(["person@partner.test"]),
		}),
		true,
	);
	assert.equal(
		canReadMessage(policy, {
			mailbox: "INBOX",
			message: fixtureMessage(["stranger@example.org"]),
		}),
		false,
	);
	assert.equal(
		canReadMessage(policy, {
			mailbox: "Archive",
			message: fixtureMessage(["trusted@example.com"]),
		}),
		false,
	);
}

runPolicyChecks();
console.log("Policy checks passed.");
