import type { SendMailOptions } from "nodemailer";
import nodemailer from "nodemailer";
import type { BridgeConfig } from "./config.js";
import type { SendEmailInput } from "./schemas.js";

function createSmtpTransport(config: BridgeConfig) {
	return nodemailer.createTransport({
		host: config.host,
		port: config.smtpPort,
		secure: false,
		auth: {
			user: config.user,
			pass: config.password,
		},
		tls: {
			rejectUnauthorized: config.tlsRejectUnauthorized,
		},
		requireTLS: true,
		connectionTimeout: 10_000,
		greetingTimeout: 10_000,
		socketTimeout: 30_000,
	});
}

export async function sendEmail(config: BridgeConfig, input: SendEmailInput) {
	const transport = createSmtpTransport(config);
	const message: SendMailOptions = {
		from: config.user,
		to: input.to,
		cc: input.cc,
		bcc: input.bcc,
		subject: input.subject,
		text: input.text,
	};

	try {
		const info = await transport.sendMail(message);
		return {
			status: info.rejected.length > 0 ? "partially_sent" : "sent",
			messageId: info.messageId,
			accepted: info.accepted,
			rejected: info.rejected,
		};
	} finally {
		transport.close();
	}
}
