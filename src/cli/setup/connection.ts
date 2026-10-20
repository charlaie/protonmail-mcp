import * as prompts from "@clack/prompts";
import { type BridgeConfig, ConfigSchema } from "../../bridge/config.js";
import {
	createImapService,
	type ImapService,
} from "../../bridge/imap/service.js";
import { verifySmtpConnection } from "../../bridge/smtp/submission.js";
import { parseSenderEmails } from "../../policy/selection.js";
import { connectionFailureMessage } from "../diagnostics/service.js";
import { answer, validatedText } from "./prompts.js";

export async function configureConnection(
	existing?: BridgeConfig,
): Promise<BridgeConfig> {
	if (
		existing &&
		!(await answer(
			prompts.confirm({
				message: "Change the saved Bridge connection?",
				initialValue: false,
			}),
		))
	)
		return existing;
	prompts.note(
		"Open Proton Mail Bridge and select your account to copy its IMAP/SMTP username and password. Use the Bridge password, not your Proton account password. Bridge must remain running and signed in.",
		"Bridge credentials",
	);
	const user = await validatedText(
		"Bridge username",
		existing?.user ?? "",
		(value) => {
			if (!value.trim()) throw new Error("Enter the username shown in Bridge.");
		},
	);
	const password = await answer(
		prompts.password({
			message: "Bridge password",
			validate: (value) =>
				!value ? "Enter the password shown in Bridge." : undefined,
		}),
	);
	let settings = {
		host: existing?.host ?? "127.0.0.1",
		imapPort: existing?.imapPort ?? 1143,
		smtpPort: existing?.smtpPort ?? 1025,
		tlsRejectUnauthorized: existing?.tlsRejectUnauthorized ?? false,
	};
	if (
		await answer(
			prompts.confirm({
				message: "Change advanced connection settings?",
				initialValue: false,
			}),
		)
	) {
		const host = await validatedText("Bridge host", settings.host, (value) => {
			if (!value.trim()) throw new Error("Enter a host.");
		});
		const parsePort = (value: string) => {
			if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)
				throw new Error("Enter a port from 1 to 65535.");
		};
		const imapPort = Number(
			await validatedText("IMAP port", String(settings.imapPort), parsePort),
		);
		const smtpPort = Number(
			await validatedText("SMTP port", String(settings.smtpPort), parsePort),
		);
		const tlsRejectUnauthorized = await answer(
			prompts.confirm({
				message:
					"Require a trusted TLS certificate? Required for remote hosts.",
				initialValue: settings.tlsRejectUnauthorized,
			}),
		);
		settings = { host, imapPort, smtpPort, tlsRejectUnauthorized };
	}
	prompts.note(
		"Your Bridge username is already included. Add any other email addresses enabled for sending on this Proton Mail account. These addresses are also excluded from reply-all recipients. Bridge cannot list them over IMAP/SMTP.",
		"Additional email addresses",
	);
	const ownAddresses = await validatedText(
		"Other email addresses you send from, separated by commas. Leave blank to skip.",
		existing?.user.toLowerCase() === user.trim().toLowerCase()
			? existing.ownAddresses
					.filter((address) => address !== existing.user.toLowerCase())
					.join(", ")
			: "",
		parseSenderEmails,
	);
	return ConfigSchema.parse({
		user,
		password,
		...settings,
		ownAddresses: parseSenderEmails(ownAddresses),
	});
}

export async function verifyConnection(
	config: BridgeConfig,
	dependencies: {
		imap?: Pick<ImapService, "listMailboxes">;
		smtp?: () => Promise<unknown>;
	} = {},
) {
	const progress = prompts.spinner();
	progress.start(
		"Checking Bridge IMAP and SMTP authentication. No mail will be sent.",
	);
	try {
		const mailboxes = await (
			dependencies.imap ?? createImapService(config)
		).listMailboxes();
		await (dependencies.smtp ?? (() => verifySmtpConnection(config)))();
		progress.stop("Bridge connection verified.");
		return mailboxes.filter((mailbox) => !mailbox.flags.includes("\\Noselect"));
	} catch (error) {
		progress.stop("Bridge connection failed.");
		throw new Error(connectionFailureMessage(error, config.password));
	}
}
