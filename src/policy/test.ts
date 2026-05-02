#!/usr/bin/env node

import { strict as assert } from "node:assert";

import type { MessageSummary } from "../bridge/serializers.js";
import {
	canReadMailbox,
	canReadMessage,
	filterAllowedMessages,
} from "./enforcement.js";
import { createReadPolicy } from "./schema.js";

function fixtureMessage(from: string[]): MessageSummary {
	return {
		uid: 1,
		subject: "Test",
		from,
		to: [],
		cc: [],
		date: new Date(0).toISOString(),
		flags: [],
		size: 100,
	};
}

function runPolicyChecks() {
	const policy = createReadPolicy({
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
	assert.deepEqual(
		filterAllowedMessages(policy, "Archive", [
			fixtureMessage(["trusted@example.com"]),
		]),
		[],
	);
}

runPolicyChecks();
console.log("Policy checks passed.");
