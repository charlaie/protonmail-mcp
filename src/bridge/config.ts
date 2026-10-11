import { isIP } from "node:net";
import { z } from "zod";

export const ConfigSchema = z
	.object({
		PROTONMAIL_BRIDGE_USER: z.string().min(1),
		PROTONMAIL_BRIDGE_PASSWORD: z.string().min(1),
		PROTONMAIL_BRIDGE_HOST: z.string().trim().min(1).default("127.0.0.1"),
		PROTONMAIL_IMAP_PORT: z.coerce
			.number()
			.int()
			.min(1)
			.max(65535)
			.default(1143),
		PROTONMAIL_SMTP_PORT: z.coerce
			.number()
			.int()
			.min(1)
			.max(65535)
			.default(1025),
		PROTONMAIL_TLS_REJECT_UNAUTHORIZED: z
			.enum(["true", "false"])
			.default("false")
			.transform((value) => value === "true"),
		PROTONMAIL_BRIDGE_OWN_ADDRESSES: z
			.string()
			.default("")
			.transform((value) =>
				value
					.split(",")
					.map((item) => item.trim().toLowerCase())
					.filter(Boolean),
			)
			.pipe(z.array(z.email())),
	})
	.refine(
		(env) =>
			env.PROTONMAIL_TLS_REJECT_UNAUTHORIZED ||
			isLoopbackHost(env.PROTONMAIL_BRIDGE_HOST),
		{
			path: ["PROTONMAIL_BRIDGE_HOST"],
			message:
				"Certificate verification may only be disabled for a literal loopback IP or localhost. Enable PROTONMAIL_TLS_REJECT_UNAUTHORIZED for remote hosts.",
		},
	)
	.transform((env) => ({
		user: env.PROTONMAIL_BRIDGE_USER,
		password: env.PROTONMAIL_BRIDGE_PASSWORD,
		host:
			env.PROTONMAIL_BRIDGE_HOST.toLowerCase() === "localhost"
				? "127.0.0.1"
				: env.PROTONMAIL_BRIDGE_HOST,
		imapPort: env.PROTONMAIL_IMAP_PORT,
		smtpPort: env.PROTONMAIL_SMTP_PORT,
		tlsRejectUnauthorized: env.PROTONMAIL_TLS_REJECT_UNAUTHORIZED,
		ownAddresses: [
			...new Set([
				env.PROTONMAIL_BRIDGE_USER.toLowerCase(),
				...env.PROTONMAIL_BRIDGE_OWN_ADDRESSES,
			]),
		],
	}));

function isLoopbackHost(host: string) {
	return (
		host.toLowerCase() === "localhost" ||
		host === "::1" ||
		(isIP(host) === 4 && host.split(".")[0] === "127")
	);
}

export type BridgeConfig = z.infer<typeof ConfigSchema>;

/** Load bridge config from environment variables. */
export function loadBridgeConfig(): BridgeConfig {
	return ConfigSchema.parse(process.env);
}
