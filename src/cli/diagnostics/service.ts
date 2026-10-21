import { createImapService, type ImapService } from "@/bridge/imap/service.js";
import { verifySmtpConnection } from "@/bridge/smtp/submission.js";
import type { LaunchSpecification } from "@/cli/clients/configuration.js";
import type { ServerConfig } from "@/config/store.js";
import { createOperationJournal } from "@/operations/journal.js";
import { readPolicyStatus } from "@/policy/enforcement.js";
import { loadReadPolicy } from "@/policy/store.js";
import { safeErrorMessage } from "@/shared/errors.js";
import { checkMcpStartup } from "./mcp.js";

export type DiagnosticResult =
	| { check: string; status: "passed"; message: string }
	| { check: string; status: "failed"; message: string; fix: string }
	| { check: string; status: "unverified"; message: string };

type Mailboxes = Awaited<ReturnType<ImapService["listMailboxes"]>>;

const CONNECTION_FAILURE_HINTS: { pattern: RegExp; hint: string }[] = [
	{
		pattern: /ECONNREFUSED|connect.*refused/i,
		hint: "Bridge is not accepting connections. Open Bridge, sign in, and check the configured ports.",
	},
	{
		pattern: /EAUTH|authentication|login.*fail|invalid.*credential/i,
		hint: "Bridge rejected the credentials. Copy the username and password from Bridge's account settings, not your Proton account password.",
	},
	{
		pattern: /certificate|self.signed/i,
		hint: "Bridge certificate verification failed. Check the host and TLS settings in this configuration.",
	},
	{
		pattern: /timeout|timed out/i,
		hint: "Bridge did not respond in time. Check that it is running and that the host and ports are correct.",
	},
];

export function connectionFailureMessage(error: unknown, password: string) {
	const message = safeErrorMessage(error).split(password).join("[redacted]");
	const known = CONNECTION_FAILURE_HINTS.find(({ pattern }) =>
		pattern.test(message),
	);
	return known?.hint ?? message;
}

export async function diagnoseServer(
	config: ServerConfig,
	launch: LaunchSpecification,
	dependencies: {
		imap?: Pick<ImapService, "listMailboxes">;
		verifySmtp?: () => Promise<unknown>;
		checkMcp?: () => Promise<string>;
	} = {},
): Promise<DiagnosticResult[]> {
	const imap = dependencies.imap ?? createImapService(config.bridge);
	const verifySmtp =
		dependencies.verifySmtp ?? (() => verifySmtpConnection(config.bridge));
	const checkMcp = dependencies.checkMcp ?? (() => checkMcpStartup(launch));
	const password = config.bridge.password;
	let mailboxes: Mailboxes | undefined;

	const results: DiagnosticResult[] = [
		{
			check: "configuration",
			status: "passed",
			message: "Versioned configuration loaded and validated.",
		},
	];
	async function check(
		name: string,
		fix: string,
		operation: () => Promise<string>,
	) {
		results.push(await runCheck(name, fix, password, operation));
	}

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
			await verifySmtp();
			return "Authenticated without sending a message. Sender acceptance and delivery remain untested.";
		},
	);
	await check(
		"permissions",
		"Run protonmail-mcp setup --section permissions with this configuration.",
		() => checkPolicy(config, mailboxes),
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
		checkMcp,
	);
	results.push({
		check: "client compatibility",
		status: "unverified",
		message:
			"In your selected client, confirm that approval forms display complete messages and that attachments are exposed as files. This command cannot verify the app's UI.",
	});
	return results;
}

async function runCheck(
	check: string,
	fix: string,
	password: string,
	operation: () => Promise<string>,
): Promise<DiagnosticResult> {
	try {
		return { check, status: "passed", message: await operation() };
	} catch (error) {
		return {
			check,
			status: "failed",
			message: connectionFailureMessage(error, password),
			fix,
		};
	}
}

/** Mailbox existence is checked only when the IMAP check listed mailboxes. */
async function checkPolicy(
	config: ServerConfig,
	mailboxes: Mailboxes | undefined,
) {
	const policy = await loadReadPolicy(config.storage.policyFile);
	const status = readPolicyStatus(policy, config.bridge.user);
	if (status !== "ok" || policy?.version !== 3)
		throw new Error(`Access policy status: ${status}.`);

	const grants = `${policy.allowedTools.length} tool grants; policy matches this Bridge account.`;
	if (!mailboxes) return `${grants} Mailbox existence could not be verified.`;

	const selectable = new Set(
		mailboxes
			.filter((mailbox) => !mailbox.flags.includes("\\Noselect"))
			.map((mailbox) => mailbox.path),
	);
	const missing = policy.allowedMailboxes.filter(
		(mailbox) => !selectable.has(mailbox),
	);
	if (missing.length)
		throw new Error(
			`Configured mailboxes no longer exist: ${missing.join(", ")}.`,
		);
	return `${grants} Mailboxes verified.`;
}
