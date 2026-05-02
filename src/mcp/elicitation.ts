import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { safeErrorMessage } from "../shared/errors.js";
import type { SendEmailInput } from "./schemas.js";

function truncate(value: string, maxLength: number): string {
	if (value.length <= maxLength) {
		return value;
	}

	return `${value.slice(0, maxLength)}...`;
}

/** Ask the user for approval to send an email. */
export async function requireSendApproval(
	server: McpServer,
	input: SendEmailInput,
) {
	const preview = truncate(input.text.replace(/\s+/g, " ").trim(), 800);

	try {
		const result = await server.server.elicitInput({
			mode: "form",
			message: [
				"Approve sending this Proton Mail email?",
				`To: ${input.to.join(", ")}`,
				input.cc?.length ? `Cc: ${input.cc.join(", ")}` : undefined,
				input.bcc?.length ? `Bcc: ${input.bcc.join(", ")}` : undefined,
				`Subject: ${input.subject}`,
				`Body preview: ${preview}`,
			]
				.filter(Boolean)
				.join("\n"),
			requestedSchema: {
				type: "object",
				properties: {
					approve_send: {
						type: "boolean",
						title: "Send email now",
						description:
							"Approve this only if the recipients, subject, and body preview are correct. Approval immediately sends the email.",
						default: false,
					},
				},
				required: ["approve_send"],
			},
		});

		const content = result.content as { approve_send?: boolean } | undefined;
		return result.action === "accept" && content?.approve_send === true;
	} catch (error) {
		console.error(`Send approval failed closed: ${safeErrorMessage(error)}`);
		return false;
	}
}
