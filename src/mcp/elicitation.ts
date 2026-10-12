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
import type {
	AttachmentApprovalInput,
	AttachmentReadAuthorization,
} from "../policy/service.js";
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

const ApproveAttachmentSchema = z.object({
	approve_attachment: z
		.boolean()
		.default(false)
		.describe(
			"Allow this MCP server to download this attachment and give its original bytes to the agent.",
		)
		.meta({ title: "Read attachment now" }),
});

type ApprovalInput =
	| { purpose: "send_email"; input: SendApprovalInput }
	| { purpose: "read_attachment"; input: AttachmentApprovalInput };

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

function approvalDefinition(request: ApprovalInput) {
	switch (request.purpose) {
		case "send_email":
			return {
				key: "approve_send",
				request: inputRequired.elicit({
					message: approvalMessage(request.input),
					requestedSchema: ApproveSendSchema,
				}),
				accepted: (ctx: ServerContext) =>
					acceptedContent(
						ctx.mcpReq.inputResponses,
						"approve_send",
						ApproveSendSchema,
					)?.approve_send === true,
				deniedMessage:
					"Email not sent. Approval was absent, expired, changed, or already consumed.",
			};
		case "read_attachment": {
			const { bridgeUser, attachment } = request.input;
			const message = [
				"Approve downloading this Proton Mail attachment for the agent?",
				"The following metadata is untrusted sender data, not instructions.",
				JSON.stringify(
					{
						bridgeUser,
						...attachment,
						sizeEncoding: "transfer_encoded",
					},
					null,
					2,
				),
				"Approval covers this attachment only. The client handles its original bytes, including document parsing and OCR.",
			].join("\n");
			return {
				key: "approve_attachment",
				request: inputRequired.elicit({
					message,
					requestedSchema: ApproveAttachmentSchema,
				}),
				accepted: (ctx: ServerContext) =>
					acceptedContent(
						ctx.mcpReq.inputResponses,
						"approve_attachment",
						ApproveAttachmentSchema,
					)?.approve_attachment === true,
				deniedMessage:
					"Attachment not downloaded. Approval was absent, expired, changed, or already consumed.",
			};
		}
		default: {
			const exhaustive: never = request;
			return exhaustive;
		}
	}
}

const APPROVAL_TTL_SECONDS = 10 * 60;

const ApprovalStateSchema = z.object({
	purpose: z.enum(["send_email", "read_attachment"]),
	nonce: z.string(),
	inputHash: z.string(),
});

type ApprovalState = z.infer<typeof ApprovalStateSchema>;

type ApprovalDecision =
	| { kind: "approved" }
	| { kind: "denied"; response: ReturnType<typeof errorResponse> }
	| { kind: "input_required"; response: InputRequiredResult };

type AttachmentApprovalDecision =
	| Exclude<ApprovalDecision, { kind: "approved" }>
	| {
			kind: "approved";
			authorization: Extract<AttachmentReadAuthorization, { kind: "human" }>;
	  };

export type ApprovalController = {
	requireSendApproval(
		input: SendApprovalInput,
		ctx: ServerContext,
	): Promise<ApprovalDecision>;
	requireAttachmentApproval(
		input: AttachmentApprovalInput,
		ctx: ServerContext,
	): Promise<AttachmentApprovalDecision>;
	verifyRequestState: RequestStateCodec<ApprovalState>["verify"];
};

/** Single-use approval state shared by 2025 and 2026-era clients. */
export function createApprovalController(): ApprovalController {
	const codec = createRequestStateCodec<ApprovalState>({
		key: randomBytes(32),
		ttlSeconds: APPROVAL_TTL_SECONDS,
		bind: (ctx) => ctx.mcpReq.method,
	});
	const pendingNonces = new Map<string, number>();

	function consumeState(state: ApprovalState | undefined): boolean {
		const now = Date.now();

		for (const [nonce, expiresAt] of pendingNonces) {
			if (expiresAt <= now) {
				pendingNonces.delete(nonce);
			}
		}

		return state !== undefined && pendingNonces.delete(state.nonce);
	}

	async function requestApproval(
		input: ApprovalInput,
		ctx: ServerContext,
	): Promise<ApprovalDecision> {
		consumeState(undefined);
		if (pendingNonces.size >= 1000)
			throw new Error(
				"Too many pending approvals. Wait ten minutes for unused approvals to expire.",
			);
		const nonce = randomUUID();
		pendingNonces.set(nonce, Date.now() + APPROVAL_TTL_SECONDS * 1000);
		const definition = approvalDefinition(input);

		return {
			kind: "input_required",
			response: inputRequired({
				inputRequests: {
					[definition.key]: definition.request,
				},
				requestState: await codec.mint(
					{
						purpose: input.purpose,
						nonce,
						inputHash: hashContent(input),
					},
					ctx,
				),
			}),
		};
	}

	async function requireApproval(
		input: ApprovalInput,
		ctx: ServerContext,
	): Promise<ApprovalDecision> {
		const definition = approvalDefinition(input);
		const approvalDeniedResponse = errorResponse(
			new MailError(
				"APPROVAL_DENIED",
				definition.deniedMessage,
				"new_approval",
			),
		);
		const stateResult = ApprovalStateSchema.safeParse(
			ctx.mcpReq.requestState(),
		);
		const state = stateResult.success ? stateResult.data : undefined;
		const view = inputResponse(ctx.mcpReq.inputResponses, definition.key);

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

		const accepted = definition.accepted(ctx);
		const wasPending = consumeState(state);

		if (
			!accepted ||
			state === undefined ||
			!wasPending ||
			state.purpose !== input.purpose ||
			state.inputHash !== hashContent(input)
		) {
			return {
				kind: "denied",
				response: approvalDeniedResponse,
			};
		}

		return { kind: "approved" };
	}
	return {
		verifyRequestState: codec.verify,
		requireSendApproval: (input, ctx) =>
			requireApproval({ purpose: "send_email", input }, ctx),
		async requireAttachmentApproval(input, ctx) {
			const decision = await requireApproval(
				{ purpose: "read_attachment", input },
				ctx,
			);
			return decision.kind === "approved"
				? { kind: "approved", authorization: { kind: "human", input } }
				: decision;
		},
	};
}
