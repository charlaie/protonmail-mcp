import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { loadBridgeConfig } from "../bridge/config.js";
import { createImapService } from "../bridge/imap.js";
import { summarizeReadPolicy } from "./enforcement.js";
import { createReadPolicy } from "./schema.js";
import {
	getPolicyFilePath,
	loadReadPolicy,
	resetReadPolicy,
	saveReadPolicy,
} from "./store.js";

function splitCsv(value: string) {
	return value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

function parseMailboxSelection(answer: string, mailboxes: string[]): string[] {
	const selected = splitCsv(answer).map((item) => {
		const index = Number(item);
		return Number.isInteger(index) && index >= 1 && index <= mailboxes.length
			? mailboxes[index - 1]
			: item;
	});

	return [...new Set(selected)];
}

export async function runSetupCommand() {
	const config = loadBridgeConfig();
	const imap = createImapService(config);
	const mailboxes = (await imap.listMailboxes())
		.map((mailbox) => mailbox.path)
		.filter(Boolean)
		.sort((a, b) => a.localeCompare(b));

	if (mailboxes.length === 0) {
		throw new Error("No selectable mailboxes were returned by Proton Bridge.");
	}

	console.log("Proton Mail MCP read policy setup");
	console.log("");
	console.log("Select which mailboxes the model may search and read.");
	console.log("");

	mailboxes.forEach((mailbox, index) => {
		console.log(`${index + 1}. ${mailbox}`);
	});

	console.log("");

	const rl = createInterface({ input, output });

	try {
		const mailboxAnswer = await rl.question(
			"Allowed mailboxes, by number or exact name, comma-separated: ",
		);
		const allowedMailboxes = parseMailboxSelection(mailboxAnswer, mailboxes);
		const invalidMailboxes = allowedMailboxes.filter(
			(mailbox) => !mailboxes.includes(mailbox),
		);

		if (allowedMailboxes.length === 0) {
			throw new Error("At least one mailbox must be selected.");
		}

		if (invalidMailboxes.length > 0) {
			throw new Error(
				`Unknown mailbox selection: ${invalidMailboxes.join(", ")}`,
			);
		}

		const allowedSenderEmails = splitCsv(
			await rl.question(
				"Optional allowed sender emails, comma-separated; blank allows any sender in selected mailboxes: ",
			),
		);
		const allowedSenderDomains = splitCsv(
			await rl.question(
				"Optional allowed sender domains, comma-separated; blank allows any sender domain in selected mailboxes: ",
			),
		);

		const policy = createReadPolicy({
			allowedMailboxes,
			allowedSenderEmails,
			allowedSenderDomains,
		});

		await saveReadPolicy(policy);

		console.log("");
		console.log(`Read policy saved to ${getPolicyFilePath()}`);
		console.log(JSON.stringify(summarizeReadPolicy(policy), null, 2));
	} finally {
		rl.close();
	}
}

export async function runPolicyCommand() {
	const policy = await loadReadPolicy();

	if (!policy) {
		console.log(
			`No read policy configured at ${getPolicyFilePath()}. Run protonmail-mcp setup first.`,
		);
		return;
	}

	console.log(JSON.stringify(summarizeReadPolicy(policy), null, 2));
}

export async function runResetPolicyCommand() {
	const policy = await loadReadPolicy();

	if (!policy) {
		console.log(
			`No read policy configured at ${getPolicyFilePath()}. Nothing to reset.`,
		);
		return;
	}

	const rl = createInterface({ input, output });

	try {
		const answer = await rl.question(
			`Reset read policy at ${getPolicyFilePath()}? Type "reset" to confirm: `,
		);

		if (answer !== "reset") {
			console.log("Read policy was not reset.");
			return;
		}

		await resetReadPolicy();
		console.log("Read policy reset.");
	} finally {
		rl.close();
	}
}
