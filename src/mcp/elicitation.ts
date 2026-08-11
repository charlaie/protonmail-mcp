import {
	acceptedContent,
	type InputRequiredResult,
	inputRequired,
	inputResponse,
	type ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { textResponse } from "./responses.js";
import type { SendEmailInput } from "./schemas.js";

const ApproveSendSchema = z.object({
	approve_send: z
		.boolean()
		.default(false)
		.describe(
			"Approve this only if the recipients, subject, and body preview are correct. Approval immediately sends the email.",
		)
		.meta({ title: "Send email now" }),
});

function truncate(value: string, maxLength: number): string {
	if (value.length <= maxLength) {
		return value;
	}

	return `${value.slice(0, maxLength)}...`;
}

function approvalMessage(input: SendEmailInput): string {
	const preview = truncate(input.text.replace(/\s+/g, " ").trim(), 800);

	return [
		"Approve sending this Proton Mail email?",
		`To: ${input.to.join(", ")}`,
		input.cc?.length ? `Cc: ${input.cc.join(", ")}` : undefined,
		input.bcc?.length ? `Bcc: ${input.bcc.join(", ")}` : undefined,
		`Subject: ${input.subject}`,
		`Body preview: ${preview}`,
	]
		.filter(Boolean)
		.join("\n");
}

const approvalDeniedResponse = textResponse(
	"Email not sent. User approval was not received.",
);

type SendApprovalDecision =
	| { kind: "approved" }
	| { kind: "denied"; response: ReturnType<typeof textResponse> }
	| { kind: "input_required"; response: InputRequiredResult };

/** Resolve send approval via MRTR elicitation (works on 2025 and 2026-era clients). */
export function requireSendApproval(
	input: SendEmailInput,
	ctx: ServerContext,
): SendApprovalDecision {
	const view = inputResponse(ctx.mcpReq.inputResponses, "approve_send");

	if (view.kind === "elicit" && view.action !== "accept") {
		return {
			kind: "denied",
			response: approvalDeniedResponse,
		};
	}

	const content = acceptedContent(
		ctx.mcpReq.inputResponses,
		"approve_send",
		ApproveSendSchema,
	);

	if (content === undefined) {
		return {
			kind: "input_required",
			response: inputRequired({
				inputRequests: {
					approve_send: inputRequired.elicit({
						message: approvalMessage(input),
						requestedSchema: ApproveSendSchema,
					}),
				},
			}),
		};
	}

	if (content.approve_send !== true) {
		return {
			kind: "denied",
			response: approvalDeniedResponse,
		};
	}

	return { kind: "approved" };
}
