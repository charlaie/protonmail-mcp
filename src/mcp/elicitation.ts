import { randomBytes, randomUUID } from "node:crypto";
import {
	acceptedContent,
	createRequestStateCodec,
	type InputRequiredResult,
	inputRequired,
	inputResponse,
	type RequestStateCodec,
	type ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { hashContent, type OutgoingMessage } from "../sending/model.js";
import { MailError } from "../shared/mail-error.js";

export type SendApprovalInput = {
	operationId: string;
	message: OutgoingMessage;
};

import { errorResponse } from "./responses.js";

const ApproveSendSchema = z.object({
	approve_send: z
		.boolean()
		.default(false)
		.describe(
			"Approve this only if the recipients, subject, and full body are correct. Approval immediately sends the email.",
		)
		.meta({ title: "Send email now" }),
});

function approvalMessage(input: SendApprovalInput): string {
	const { message } = input;
	return [
		"Approve sending this Proton Mail email?",
		`Operation: ${input.operationId}`,
		`From: ${message.from}`,
		`To: ${message.to.join(", ")}`,
		message.cc?.length ? `Cc: ${message.cc.join(", ")}` : undefined,
		message.bcc?.length ? `Bcc: ${message.bcc.join(", ")}` : undefined,
		`Subject: ${message.subject}`,
		message.replyTo ? `Reply-To: ${message.replyTo}` : undefined,
		message.inReplyTo.length
			? `In-Reply-To: ${message.inReplyTo.join(" ")}`
			: undefined,
		message.references.length
			? `References: ${message.references.join(" ")}`
			: undefined,
		`Body:\n${message.text}`,
	]
		.filter(Boolean)
		.join("\n");
}

const approvalDeniedResponse = errorResponse(
	new MailError(
		"APPROVAL_DENIED",
		"Email not sent. Approval was absent, expired, changed, or already consumed.",
		"new_approval",
	),
);

const APPROVAL_TTL_SECONDS = 10 * 60;

const SendApprovalStateSchema = z.object({
	purpose: z.literal("send_email"),
	nonce: z.string(),
	inputHash: z.string(),
});

type SendApprovalState = z.infer<typeof SendApprovalStateSchema>;

type SendApprovalDecision =
	| { kind: "approved" }
	| { kind: "denied"; response: ReturnType<typeof errorResponse> }
	| { kind: "input_required"; response: InputRequiredResult };

export type SendApprovalController = {
	requireApproval(
		input: SendApprovalInput,
		ctx: ServerContext,
	): Promise<SendApprovalDecision>;
	verifyRequestState: RequestStateCodec<SendApprovalState>["verify"];
};

function inputHash(input: SendApprovalInput): string {
	return hashContent(input);
}

/** Create an MRTR send-approval guard shared by 2025 and 2026-era clients. */
export function createSendApprovalController(): SendApprovalController {
	const codec = createRequestStateCodec<SendApprovalState>({
		key: randomBytes(32),
		ttlSeconds: APPROVAL_TTL_SECONDS,
		bind: (ctx) => ctx.mcpReq.method,
	});
	const pendingNonces = new Map<string, number>();

	function consumeState(state: SendApprovalState | undefined): boolean {
		const now = Date.now();

		for (const [nonce, expiresAt] of pendingNonces) {
			if (expiresAt <= now) {
				pendingNonces.delete(nonce);
			}
		}

		return state !== undefined && pendingNonces.delete(state.nonce);
	}

	async function requestApproval(
		input: SendApprovalInput,
		ctx: ServerContext,
	): Promise<SendApprovalDecision> {
		consumeState(undefined);
		if (pendingNonces.size >= 1000)
			throw new Error(
				"Too many pending send approvals. Wait ten minutes for unused approvals to expire.",
			);
		const nonce = randomUUID();
		pendingNonces.set(nonce, Date.now() + APPROVAL_TTL_SECONDS * 1000);

		return {
			kind: "input_required",
			response: inputRequired({
				inputRequests: {
					approve_send: inputRequired.elicit({
						message: approvalMessage(input),
						requestedSchema: ApproveSendSchema,
					}),
				},
				requestState: await codec.mint(
					{
						purpose: "send_email",
						nonce,
						inputHash: inputHash(input),
					},
					ctx,
				),
			}),
		};
	}

	return {
		verifyRequestState: codec.verify,
		async requireApproval(input, ctx) {
			const stateResult = SendApprovalStateSchema.safeParse(
				ctx.mcpReq.requestState(),
			);
			const state = stateResult.success ? stateResult.data : undefined;
			const view = inputResponse(ctx.mcpReq.inputResponses, "approve_send");

			if (view.kind === "missing") {
				consumeState(state);
				return requestApproval(input, ctx);
			}

			if (view.kind !== "elicit" || view.action !== "accept") {
				consumeState(state);
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
			const wasPending = consumeState(state);

			if (
				content?.approve_send !== true ||
				state === undefined ||
				!wasPending ||
				state.inputHash !== inputHash(input)
			) {
				return {
					kind: "denied",
					response: approvalDeniedResponse,
				};
			}

			return { kind: "approved" };
		},
	};
}
