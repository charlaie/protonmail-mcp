#!/usr/bin/env node

import { strict as assert } from "node:assert";
import { messageSummary } from "@/bridge/imap/serializers.js";
import type { MessageSummary } from "@/mail/message.js";
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

	const messageCases: [mailbox: string, sender: string, readable: boolean][] = [
		["INBOX", "Trusted <trusted@example.com>", true],
		["INBOX", "person@partner.test", true],
		["INBOX", "stranger@example.org", false],
		["Archive", "trusted@example.com", false],
	];
	for (const [mailbox, sender, readable] of messageCases)
		assert.equal(
			canReadMessage(policy, {
				mailbox,
				message: fixtureMessage([sender]),
			}),
			readable,
			`${sender} in ${mailbox}`,
		);
}

runPolicyChecks();
console.log("Policy checks passed.");
