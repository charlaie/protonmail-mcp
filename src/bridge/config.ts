import { isIP } from "node:net";
import { z } from "zod";

function isLocalhost(host: string) {
	return host.toLowerCase() === "localhost";
}

function isLoopbackHost(host: string) {
	return (
		isLocalhost(host) ||
		host === "::1" ||
		(isIP(host) === 4 && host.split(".")[0] === "127")
	);
}

function uniqueLowercase(addresses: string[]) {
	return [...new Set(addresses.map((address) => address.toLowerCase()))];
}

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
		host: isLocalhost(config.host) ? "127.0.0.1" : config.host,
		ownAddresses: uniqueLowercase([config.user, ...config.ownAddresses]),
	}));

export type BridgeConfig = z.infer<typeof ConfigSchema>;
