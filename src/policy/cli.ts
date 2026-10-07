import { stdin as input, stdout as output } from "node:process";
import { createInterface, type Interface } from "node:readline/promises";

import { loadBridgeConfig } from "../bridge/config.js";
import { createImapService } from "../bridge/imap.js";
import { safeErrorMessage } from "../shared/errors.js";
import { summarizeReadPolicy } from "./enforcement.js";
import { createReadPolicy } from "./schema.js";
import {
	parseMailboxSelection,
	parseSenderDomains,
	parseSenderEmails,
} from "./selection.js";
import {
	getPolicyFilePath,
	hasReadPolicyFile,
	loadReadPolicy,
	resetReadPolicy,
	saveReadPolicy,
} from "./store.js";

function requireTerminal() {
	if (!input.isTTY || !output.isTTY)
		throw new Error(
			"This command requires an interactive terminal. Run protonmail-mcp setup or reset-policy in your terminal.",
		);
}

async function ask<T>(
	rl: Interface,
	prompt: string,
	parse: (answer: string) => T,
): Promise<T> {
	while (true) {
		const answer = await rl.question(prompt);
		try {
			return parse(answer);
		} catch (error) {
			console.error(safeErrorMessage(error));
		}
	}
}

export async function runSetupCommand() {
	requireTerminal();
	const config = loadBridgeConfig();
	const imap = createImapService(config);
	const mailboxes = (await imap.listMailboxes())
		.filter((mailbox) => !mailbox.flags.includes("\\Noselect"))
		.map((mailbox) => mailbox.path)
		.filter(Boolean)
		.sort((a, b) => a.localeCompare(b));

	if (mailboxes.length === 0) {
		throw new Error("No selectable mailboxes were returned by Proton Bridge.");
	}

	console.log("Proton Mail MCP read policy setup");
	console.log("");
	console.log("Select which mailboxes the model may search and read.");
	console.log("Include Drafts to enable draft creation and editing.");
	console.log(
		"Sender access matches either list below. Leave both lists empty to allow every sender.",
	);
	console.log("");

	mailboxes.forEach((mailbox, index) => {
		console.log(`${index + 1}. ${mailbox}`);
	});

	console.log("");

	const rl = createInterface({ input, output });

	try {
		const allowedMailboxes = await ask(
			rl,
			"Allowed mailboxes, by number or exact name, comma-separated: ",
			(answer) => parseMailboxSelection(answer, mailboxes),
		);
		const allowedSenderEmails = await ask(
			rl,
			"Allowed sender emails, comma-separated. Blank leaves this list empty: ",
			parseSenderEmails,
		);
		const allowedSenderDomains = await ask(
			rl,
			"Allowed sender domains, comma-separated. Blank leaves this list empty: ",
			parseSenderDomains,
		);

		const policy = createReadPolicy({
			bridgeUser: config.user,
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
	const exists = await hasReadPolicyFile();

	if (!exists) {
		console.log(
			`No read policy configured at ${getPolicyFilePath()}. Nothing to reset.`,
		);
		return;
	}
	requireTerminal();

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
