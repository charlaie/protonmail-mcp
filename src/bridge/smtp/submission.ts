import nodemailer from "nodemailer";
import { z } from "zod";
import type { BridgeConfig } from "@/bridge/config.js";
import { mediaMailOptions } from "@/mail/outgoing/media/mime.js";
import type { OutgoingMessage } from "@/mail/outgoing/message.js";
import type { SmtpOutcome } from "@/mail/sending/model.js";
import { safeErrorMessage } from "@/shared/errors.js";

const SmtpErrorSchema = z.object({
	code: z.string().optional(),
	command: z.string().optional(),
	responseCode: z.number().optional(),
});

// Nodemailer also reports socket failures after DATA as CONN, so that code
// cannot prove the message was rejected.
const REJECTION_CODES = ["EAUTH", "EENVELOPE", "EDNS"];

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

function isDefiniteRejection(error: unknown) {
	const parsed = SmtpErrorSchema.safeParse(error);
	if (!parsed.success) return false;

	const { code, responseCode } = parsed.data;
	const smtpErrorReply =
		responseCode !== undefined && responseCode >= 400 && responseCode <= 599;
	return smtpErrorReply || REJECTION_CODES.includes(code ?? "");
}

export function smtpFailure(error: unknown): SmtpOutcome {
	const message = safeErrorMessage(error);
	if (isDefiniteRejection(error))
		return { status: "rejected", reason: message };
	return {
		status: "uncertain",
		reason: `SMTP acceptance could not be confirmed: ${message}. Reconcile this operation before considering another send.`,
	};
}

function submissionOptions(message: OutgoingMessage, messageId: string) {
	return {
		...message,
		...mediaMailOptions(message.text, message.media),
		messageId,
		inReplyTo: message.inReplyTo.length
			? message.inReplyTo.join(" ")
			: undefined,
		references: message.references.length ? message.references : undefined,
	};
}

function recipientAddress(recipient: string | { address: string }) {
	return typeof recipient === "string" ? recipient : recipient.address;
}

export async function submitEmail(
	config: BridgeConfig,
	message: OutgoingMessage,
	messageId: string,
): Promise<SmtpOutcome> {
	const transport = createSmtpTransport(config);
	try {
		const info = await transport.sendMail(
			submissionOptions(message, messageId),
		);
		const accepted = info.accepted.map(recipientAddress);
		const rejected = info.rejected.map(recipientAddress);
		return {
			status: rejected.length ? "partially_accepted" : "accepted",
			accepted,
			rejected,
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
