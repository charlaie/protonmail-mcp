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

const APPROVAL_TTL_SECONDS = 10 * 60;

const SendApprovalStateSchema = z.object({
	purpose: z.literal("send_email"),
	nonce: z.string(),
	inputHash: z.string(),
});

type SendApprovalState = z.infer<typeof SendApprovalStateSchema>;

type SendApprovalDecision =
	| { kind: "approved" }
	| { kind: "denied"; response: ReturnType<typeof textResponse> }
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
			if (expiresAt < now) {
				pendingNonces.delete(nonce);
			}
		}

		return state !== undefined && pendingNonces.delete(state.nonce);
	}

	async function requestApproval(
		input: SendEmailInput,
		ctx: ServerContext,
	): Promise<SendApprovalDecision> {
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
