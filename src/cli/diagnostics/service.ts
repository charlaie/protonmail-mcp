import {
	createImapService,
	type ImapService,
} from "../../bridge/imap/service.js";
import { verifySmtpConnection } from "../../bridge/smtp/submission.js";
import type { ServerConfig } from "../../config/store.js";
import { createOperationJournal } from "../../operations/journal.js";
import { readPolicyStatus } from "../../policy/enforcement.js";
import { loadReadPolicy } from "../../policy/store.js";
import { safeErrorMessage } from "../../shared/errors.js";
import type { LaunchSpecification } from "../clients/configuration.js";
import { checkMcpStartup } from "./mcp.js";

export type DiagnosticResult =
	| { check: string; status: "passed"; message: string }
	| { check: string; status: "failed"; message: string; fix: string }
	| { check: string; status: "unverified"; message: string };

export function connectionFailureMessage(error: unknown, password: string) {
	const message = safeErrorMessage(error).split(password).join("[redacted]");
	if (/ECONNREFUSED|connect.*refused/i.test(message))
		return "Bridge is not accepting connections. Open Bridge, sign in, and check the configured ports.";
	if (/EAUTH|authentication|login.*fail|invalid.*credential/i.test(message))
		return "Bridge rejected the credentials. Copy the username and password from Bridge's account settings, not your Proton account password.";
	if (/certificate|self.signed/i.test(message))
		return "Bridge certificate verification failed. Check the host and TLS settings in this configuration.";
	if (/timeout|timed out/i.test(message))
		return "Bridge did not respond in time. Check that it is running and that the host and ports are correct.";
	return message;
}

export async function diagnoseServer(
	config: ServerConfig,
	launch: LaunchSpecification,
	dependencies: {
		imap?: Pick<ImapService, "listMailboxes">;
		verifySmtp?: () => Promise<unknown>;
		checkMcp?: () => Promise<string>;
	} = {},
) {
	const results: DiagnosticResult[] = [];
	async function check(
		name: string,
		fix: string,
		operation: () => Promise<string>,
	) {
		try {
			results.push({
				check: name,
				status: "passed",
				message: await operation(),
			});
		} catch (error) {
			results.push({
				check: name,
				status: "failed",
				message: connectionFailureMessage(error, config.bridge.password),
				fix,
			});
		}
	}
	const imap = dependencies.imap ?? createImapService(config.bridge);
	let mailboxes: Awaited<ReturnType<ImapService["listMailboxes"]>> | undefined;
	results.push({
		check: "configuration",
		status: "passed",
		message: "Versioned configuration loaded and validated.",
	});
	await check(
		"imap",
		"Open Bridge and check bridge.user, bridge.password, bridge.host and bridge.imapPort.",
		async () => {
			mailboxes = await imap.listMailboxes();
			return `Authenticated; ${mailboxes.length} mailboxes found.`;
		},
	);
	await check(
		"smtp",
		"Check bridge.smtpPort and Bridge credentials.",
		async () => {
			await (
				dependencies.verifySmtp ?? (() => verifySmtpConnection(config.bridge))
			)();
			return "Authenticated without sending a message. Sender acceptance and delivery remain untested.";
		},
	);
	await check(
		"permissions",
		"Run protonmail-mcp setup --section permissions with this configuration.",
		async () => {
			const policy = await loadReadPolicy(config.storage.policyFile);
			const status = readPolicyStatus(policy, config.bridge.user);
			if (status !== "ok" || policy?.version !== 3)
				throw new Error(`Access policy status: ${status}.`);
			if (mailboxes) {
				const available = new Set(
					mailboxes
						.filter((mailbox) => !mailbox.flags.includes("\\Noselect"))
						.map((mailbox) => mailbox.path),
				);
				const missing = policy.allowedMailboxes.filter(
					(mailbox) => !available.has(mailbox),
				);
				if (missing.length)
					throw new Error(
						`Configured mailboxes no longer exist: ${missing.join(", ")}.`,
					);
			}
			return `${policy.allowedTools.length} tool grants; policy matches this Bridge account.${mailboxes ? " Mailboxes verified." : " Mailbox existence could not be verified."}`;
		},
	);
	await check(
		"journal",
		"Restore access to storage.operationsDirectory. Keep the existing journal when repairing configuration.",
		async () => {
			await createOperationJournal(
				config.bridge.user,
				config.storage.operationsDirectory,
			).checkIntegrity();
			return "Account journal is accessible and passed SQLite integrity checks.";
		},
	);
	await check(
		"mcp",
		"Regenerate the client configuration and verify its absolute executable and config paths.",
		dependencies.checkMcp ?? (() => checkMcpStartup(launch)),
	);
	results.push({
		check: "client compatibility",
		status: "unverified",
		message:
			"In your selected client, confirm that approval forms display complete messages and that attachments are exposed as files. This command cannot verify the app's UI.",
	});
	return results;
}
