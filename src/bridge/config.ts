import { z } from "zod";

const ConfigSchema = z.object({
	user: z.string().min(1),
	password: z.string().min(1),
	host: z.string().min(1).default("127.0.0.1"),
	imapPort: z.coerce.number().int().positive().default(1143),
	smtpPort: z.coerce.number().int().positive().default(1025),
	tlsRejectUnauthorized: z
		.enum(["true", "false"])
		.default("false")
		.transform((value) => value === "true"),
});

export type BridgeConfig = z.infer<typeof ConfigSchema>;

/** Load bridge config from environment variables. */
export function loadBridgeConfig(): BridgeConfig {
	return ConfigSchema.parse({
		user: process.env.PROTONMAIL_BRIDGE_USER,
		password: process.env.PROTONMAIL_BRIDGE_PASSWORD,
		host: process.env.PROTONMAIL_BRIDGE_HOST,
		imapPort: process.env.PROTONMAIL_IMAP_PORT,
		smtpPort: process.env.PROTONMAIL_SMTP_PORT,
		tlsRejectUnauthorized: process.env.PROTONMAIL_TLS_REJECT_UNAUTHORIZED,
	});
}
