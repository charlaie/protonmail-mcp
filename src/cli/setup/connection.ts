import * as prompts from "@clack/prompts";
import { type BridgeConfig, ConfigSchema } from "@/bridge/config.js";
import { createImapService, type ImapService } from "@/bridge/imap/service.js";
import { verifySmtpConnection } from "@/bridge/smtp/submission.js";
import { connectionFailureMessage } from "@/cli/diagnostics/service.js";
import { parseSenderEmails } from "@/policy/selection.js";
import { answer, confirm, requireNonBlank, validatedText } from "./prompts.js";

type ConnectionSettings = Pick<
	BridgeConfig,
	"host" | "imapPort" | "smtpPort" | "tlsRejectUnauthorized"
>;

export async function configureConnection(
	existing?: BridgeConfig,
): Promise<BridgeConfig> {
	if (
		existing &&
		!(await confirm("Change the saved Bridge connection?", false))
	)
		return existing;

	prompts.note(
		"Open Proton Mail Bridge and select your account to copy its IMAP/SMTP username and password. Use the Bridge password, not your Proton account password. Bridge must remain running and signed in.",
		"Bridge credentials",
	);
	const user = await validatedText(
		"Bridge username",
		existing?.user ?? "",
		requireNonBlank("Enter the username shown in Bridge."),
	);
	const password = await answer(
		prompts.password({
			message: "Bridge password",
			validate: (value) =>
				!value ? "Enter the password shown in Bridge." : undefined,
		}),
	);
	const settings = await chooseConnectionSettings({
		host: existing?.host ?? "127.0.0.1",
		imapPort: existing?.imapPort ?? 1143,
		smtpPort: existing?.smtpPort ?? 1025,
		tlsRejectUnauthorized: existing?.tlsRejectUnauthorized ?? false,
	});
	const ownAddresses = await chooseOwnAddresses(existing, user);

	return ConfigSchema.parse({ user, password, ...settings, ownAddresses });
}

async function chooseConnectionSettings(
	defaults: ConnectionSettings,
): Promise<ConnectionSettings> {
	if (!(await confirm("Change advanced connection settings?", false)))
		return defaults;

	const host = await validatedText(
		"Bridge host",
		defaults.host,
		requireNonBlank("Enter a host."),
	);
	const imapPort = Number(
		await validatedText("IMAP port", String(defaults.imapPort), requirePort),
	);
	const smtpPort = Number(
		await validatedText("SMTP port", String(defaults.smtpPort), requirePort),
	);
	const tlsRejectUnauthorized = await confirm(
		"Require a trusted TLS certificate? Required for remote hosts.",
		defaults.tlsRejectUnauthorized,
	);
	return { host, imapPort, smtpPort, tlsRejectUnauthorized };
}

function requirePort(value: string) {
	if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)
		throw new Error("Enter a port from 1 to 65535.");
}

async function chooseOwnAddresses(
	existing: BridgeConfig | undefined,
	user: string,
) {
	prompts.note(
		"Your Bridge username is already included. Add any other email addresses enabled for sending on this Proton Mail account. These addresses are also excluded from reply-all recipients. Bridge cannot list them over IMAP/SMTP.",
		"Additional email addresses",
	);
	const addresses = await validatedText(
		"Other email addresses you send from, separated by commas. Leave blank to skip.",
		savedAdditionalAddresses(existing, user),
		parseSenderEmails,
	);
	return parseSenderEmails(addresses);
}

/** Saved addresses carry over only while the Bridge account stays the same. */
function savedAdditionalAddresses(
	existing: BridgeConfig | undefined,
	user: string,
) {
	const savedUser = existing?.user.toLowerCase();
	if (!existing || savedUser !== user.trim().toLowerCase()) return "";
	return existing.ownAddresses
		.filter((address) => address !== savedUser)
		.join(", ");
}

export async function verifyConnection(
	config: BridgeConfig,
	dependencies: {
		imap?: Pick<ImapService, "listMailboxes">;
		smtp?: () => Promise<unknown>;
	} = {},
) {
	const verifySmtp = dependencies.smtp ?? (() => verifySmtpConnection(config));
	const progress = prompts.spinner();
	progress.start(
		"Checking Bridge IMAP and SMTP authentication. No mail will be sent.",
	);
	try {
		const imap = dependencies.imap ?? createImapService(config);
		const mailboxes = await imap.listMailboxes();
		await verifySmtp();
		progress.stop("Bridge connection verified.");
		return mailboxes.filter((mailbox) => !mailbox.flags.includes("\\Noselect"));
	} catch (error) {
		progress.stop("Bridge connection failed.");
		throw new Error(connectionFailureMessage(error, config.password));
	}
}
