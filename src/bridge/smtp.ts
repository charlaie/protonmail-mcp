import nodemailer from "nodemailer";
import { z } from "zod";
import type { OutgoingMessage } from "../outgoing/message.js";
import { mediaMailOptions } from "../outgoing/mime.js";
import type { SmtpOutcome } from "../sending/model.js";
import { safeErrorMessage } from "../shared/errors.js";
import type { BridgeConfig } from "./config.js";

function createSmtpTransport(config: BridgeConfig) {
	return nodemailer.createTransport({
		host: config.host,
		port: config.smtpPort,
		secure: false,
		auth: { user: config.user, pass: config.password },
		tls: { rejectUnauthorized: config.tlsRejectUnauthorized },
		requireTLS: true,
		connectionTimeout: 10_000,
		greetingTimeout: 10_000,
		socketTimeout: 30_000,
		disableFileAccess: true,
		disableUrlAccess: true,
	});
}

const SmtpErrorSchema = z.object({
	code: z.string().optional(),
	command: z.string().optional(),
	responseCode: z.number().optional(),
});

export function smtpFailure(error: unknown): SmtpOutcome {
	const parsed = SmtpErrorSchema.safeParse(error);
	const details = parsed.success ? parsed.data : undefined;
	const rejected =
		details &&
		((details.responseCode !== undefined &&
			details.responseCode >= 400 &&
			details.responseCode <= 599) ||
			// Socket failures after DATA are also reported as CONN by Nodemailer.
			["EAUTH", "EENVELOPE", "EDNS"].includes(details.code ?? ""));
	return rejected
		? { status: "rejected", reason: safeErrorMessage(error) }
		: {
				status: "uncertain",
				reason: `SMTP acceptance could not be confirmed: ${safeErrorMessage(error)}. Reconcile this operation before considering another send.`,
			};
}

export async function submitEmail(
	config: BridgeConfig,
	message: OutgoingMessage,
	messageId: string,
): Promise<SmtpOutcome> {
	const transport = createSmtpTransport(config);
	try {
		const info = await transport.sendMail({
			...message,
			...mediaMailOptions(message.text, message.media),
			messageId,
			inReplyTo: message.inReplyTo.length
				? message.inReplyTo.join(" ")
				: undefined,
			references: message.references.length ? message.references : undefined,
		});
		const addressText = (value: string | { address: string }) =>
			typeof value === "string" ? value : value.address;
		return {
			status: info.rejected.length ? "partially_accepted" : "accepted",
			accepted: info.accepted.map(addressText),
			rejected: info.rejected.map(addressText),
		};
	} catch (error) {
		return smtpFailure(error);
	} finally {
		transport.close();
	}
}

export async function verifySmtpConnection(config: BridgeConfig) {
	const transport = createSmtpTransport(config);
	try {
		return await transport.verify();
	} finally {
		transport.close();
	}
}
