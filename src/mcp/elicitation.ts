import { createHash, randomBytes, randomUUID } from "node:crypto";
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
import type { SendEmailInput } from "../bridge/schemas.js";
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

function approvalMessage(input: SendEmailInput, sender: string): string {
	return [
		"Approve sending this Proton Mail email?",
		`From: ${sender}`,
		`To: ${input.to.join(", ")}`,
		input.cc?.length ? `Cc: ${input.cc.join(", ")}` : undefined,
		input.bcc?.length ? `Bcc: ${input.bcc.join(", ")}` : undefined,
		`Subject: ${input.subject}`,
		`Body:\n${input.text}`,
	]
		.filter(Boolean)
		.join("\n");
}

const approvalDeniedResponse = errorResponse(
	"Email not sent. User approval was not received.",
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
		input: SendEmailInput,
		ctx: ServerContext,
	): Promise<SendApprovalDecision>;
	verifyRequestState: RequestStateCodec<SendApprovalState>["verify"];
};

function inputHash(input: SendEmailInput): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				to: input.to,
				cc: input.cc ?? [],
				bcc: input.bcc ?? [],
				subject: input.subject,
				text: input.text,
			}),
		)
		.digest("base64url");
}

/** Create an MRTR send-approval guard shared by 2025 and 2026-era clients. */
export function createSendApprovalController(
	sender: string,
): SendApprovalController {
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
		input: SendEmailInput,
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
						message: approvalMessage(input, sender),
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
