import { isIP } from "node:net";
import { z } from "zod";

export const ConfigSchema = z
	.strictObject({
		user: z.string().trim().min(1),
		password: z.string().min(1),
		host: z.string().trim().min(1).default("127.0.0.1"),
		imapPort: z.number().int().min(1).max(65535).default(1143),
		smtpPort: z.number().int().min(1).max(65535).default(1025),
		tlsRejectUnauthorized: z.boolean().default(false),
		ownAddresses: z.array(z.email()).default([]),
	})
	.refine(
		(config) => config.tlsRejectUnauthorized || isLoopbackHost(config.host),
		{
			path: ["host"],
			message:
				"Certificate verification may only be disabled for a literal loopback IP or localhost. Set bridge.tlsRejectUnauthorized to true for remote hosts.",
		},
	)
	.transform((config) => ({
		...config,
		host: config.host.toLowerCase() === "localhost" ? "127.0.0.1" : config.host,
		ownAddresses: [
			...new Set(
				[config.user, ...config.ownAddresses].map((address) =>
					address.toLowerCase(),
				),
			),
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
