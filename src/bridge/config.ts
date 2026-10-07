import { z } from "zod";

const ConfigSchema = z
	.object({
		PROTONMAIL_BRIDGE_USER: z.string().min(1),
		PROTONMAIL_BRIDGE_PASSWORD: z.string().min(1),
		PROTONMAIL_BRIDGE_HOST: z.string().min(1).default("127.0.0.1"),
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
	})
	.transform((env) => ({
		user: env.PROTONMAIL_BRIDGE_USER,
		password: env.PROTONMAIL_BRIDGE_PASSWORD,
		host: env.PROTONMAIL_BRIDGE_HOST,
		imapPort: env.PROTONMAIL_IMAP_PORT,
		smtpPort: env.PROTONMAIL_SMTP_PORT,
		tlsRejectUnauthorized: env.PROTONMAIL_TLS_REJECT_UNAUTHORIZED,
	}));

export type BridgeConfig = z.infer<typeof ConfigSchema>;

/** Load bridge config from environment variables. */
export function loadBridgeConfig(): BridgeConfig {
	return ConfigSchema.parse(process.env);
}
