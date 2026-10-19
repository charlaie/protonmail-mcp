import { z } from "zod";
import type { BridgeConfig } from "../bridge/config.js";
import { MailError } from "../shared/mail-error.js";

export function configuredSenderSchema(config: BridgeConfig) {
	return z
		.enum(config.ownAddresses)
		.describe(
			"Exact configured sender address. Omit to use the default sender; replies default to an own address among the original To/Cc recipients, then the Bridge username.",
		);
}

export function resolveSender(config: BridgeConfig, address = config.user) {
	const parsed = configuredSenderSchema(config).safeParse(
		address.toLowerCase(),
	);
	if (!parsed.success)
		throw new MailError(
			"INVALID_INPUT",
			"Sender must be one of this account's configured own addresses. Run setup to configure sender aliases.",
			"configure",
		);
	return parsed.data;
}
