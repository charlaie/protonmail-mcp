import { ImapFlow } from "imapflow";
import { safeErrorMessage } from "../../shared/errors.js";
import { MailError } from "../../shared/mail-error.js";
import type { BridgeConfig } from "../config.js";

export type ImapClient = Pick<
	ImapFlow,
	| "list"
	| "mailboxCreate"
	| "mailboxOpen"
	| "search"
	| "fetchAll"
	| "fetchOne"
	| "download"
	| "append"
	| "messageDelete"
	| "messageMove"
	| "messageFlagsAdd"
	| "messageFlagsRemove"
	| "capabilities"
>;
export type ImapSession = <T>(
	operation: (client: ImapClient) => Promise<T>,
) => Promise<T>;

type Connection = ImapClient &
	Pick<ImapFlow, "connect" | "logout" | "close"> & {
		on(event: "error", listener: (error: Error) => void): void;
	};

function createClient(config: BridgeConfig): Connection {
	return new ImapFlow({
		host: config.host,
		port: config.imapPort,
		secure: false,
		auth: { user: config.user, pass: config.password },
		tls: { rejectUnauthorized: config.tlsRejectUnauthorized },
		doSTARTTLS: true,
		logger: false,
		connectionTimeout: 10_000,
		greetingTimeout: 10_000,
		socketTimeout: 30_000,
	});
}

export function createImapSession(
	config: BridgeConfig,
	factory = createClient,
): ImapSession {
	return async (operation) => {
		const client = factory(config);
		let connectionError: Error | undefined;
		let connected = false;
		const failed = new Promise<never>((_, reject) => {
			client.on("error", (error) => {
				connectionError = error;
				// Closing rejects outstanding commands. Let the operation settle so
				// known mutations can return their recovery details.
				client.close();
				reject(error);
			});
		});

		try {
			await Promise.race([client.connect(), failed]);
			connected = true;
			return await operation(client);
		} catch (error) {
			if (error instanceof MailError) throw error;
			throw new MailError(
				!connected || connectionError
					? "CONNECTION_FAILED"
					: "OPERATION_FAILED",
				safeErrorMessage(error),
				!connected ? "safe" : "never",
				{ cause: error },
			);
		} finally {
			if (connected && !connectionError) {
				await client.logout().catch(() => client.close());
			} else {
				client.close();
			}
		}
	};
}
