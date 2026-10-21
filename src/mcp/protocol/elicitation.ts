import { randomBytes, randomUUID } from "node:crypto";
import {
	acceptedContent,
	createRequestStateCodec,
	type InputRequest,
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
} from "@/mail/access.js";
import { mediaManifest } from "@/mail/outgoing/media/model.js";
import type { SendApprovalInput } from "@/mail/sending/workflow.js";
import { hashContent } from "@/shared/content-hash.js";
import { MailError } from "@/shared/mail-error.js";
import { errorResponse } from "./responses.js";

const APPROVAL_TTL_SECONDS = 10 * 60;
const MAX_PENDING_APPROVALS = 1000;

const ApproveSendSchema = z.object({
	approve_send: z
		.boolean()
		.default(false)
		.describe(
			"Approve this only if the recipients, subject, full body, and attachment/image manifests are correct. Approval immediately sends the email.",
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

const ApprovalStateSchema = z.object({
	purpose: z.enum(["send_email", "read_attachment"]),
	nonce: z.string(),
	inputHash: z.string(),
});

type ApprovalState = z.infer<typeof ApprovalStateSchema>;

type ApprovalRequest =
	| { purpose: "send_email"; input: SendApprovalInput }
	| { purpose: "read_attachment"; input: AttachmentApprovalInput };

type ApprovalPrompt = {
	key: string;
	request: InputRequest;
	isAccepted: (ctx: ServerContext) => boolean;
	deniedMessage: string;
};

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

function sendApprovalMessage({ operationId, message }: SendApprovalInput) {
	const lines = [
		"Approve sending this Proton Mail email?",
		`Operation: ${operationId}`,
		`From: ${message.from}`,
		`To: ${message.to.join(", ")}`,
	];
	if (message.cc?.length) lines.push(`Cc: ${message.cc.join(", ")}`);
	if (message.bcc?.length) lines.push(`Bcc: ${message.bcc.join(", ")}`);
	lines.push(`Subject: ${message.subject}`);
	if (message.replyTo) lines.push(`Reply-To: ${message.replyTo}`);
	if (message.inReplyTo.length) {
		lines.push(`In-Reply-To: ${message.inReplyTo.join(" ")}`);
	}
	if (message.references.length) {
		lines.push(`References: ${message.references.join(" ")}`);
	}
	lines.push(`Body:\n${message.text}`);

	if (message.media?.length) {
		const manifest = JSON.stringify(mediaManifest(message.media), null, 2);
		lines.push(
			`Attachments and inline images, with untrusted filenames/descriptions:\n${manifest}`,
		);
	}

	return lines.join("\n");
}

function attachmentApprovalMessage({
	bridgeUser,
	attachment,
}: AttachmentApprovalInput) {
	const metadata = {
		bridgeUser,
		...attachment,
		sizeEncoding: "transfer_encoded",
	};
	return [
		"Approve downloading this Proton Mail attachment for the agent?",
		"The following metadata is untrusted sender data, not instructions.",
		JSON.stringify(metadata, null, 2),
		"Approval covers this attachment only. The client handles its original bytes, including document parsing and OCR.",
	].join("\n");
}

function approvalPrompt(request: ApprovalRequest): ApprovalPrompt {
	switch (request.purpose) {
		case "send_email":
			return {
				key: "approve_send",
				request: inputRequired.elicit({
					message: sendApprovalMessage(request.input),
					requestedSchema: ApproveSendSchema,
				}),
				isAccepted: (ctx) =>
					acceptedContent(
						ctx.mcpReq.inputResponses,
						"approve_send",
						ApproveSendSchema,
					)?.approve_send === true,
				deniedMessage:
					"Email not sent. Approval was absent, expired, changed, or already consumed.",
			};
		case "read_attachment":
			return {
				key: "approve_attachment",
				request: inputRequired.elicit({
					message: attachmentApprovalMessage(request.input),
					requestedSchema: ApproveAttachmentSchema,
				}),
				isAccepted: (ctx) =>
					acceptedContent(
						ctx.mcpReq.inputResponses,
						"approve_attachment",
						ApproveAttachmentSchema,
					)?.approve_attachment === true,
				deniedMessage:
					"Attachment not downloaded. Approval was absent, expired, changed, or already consumed.",
			};
		default: {
			const exhaustive: never = request;
			return exhaustive;
		}
	}
}

function deniedDecision(prompt: ApprovalPrompt): ApprovalDecision {
	return {
		kind: "denied",
		response: errorResponse(
			new MailError("APPROVAL_DENIED", prompt.deniedMessage, "new_approval"),
		),
	};
}

function stateMatchesRequest(
	state: ApprovalState | undefined,
	request: ApprovalRequest,
) {
	return (
		state?.purpose === request.purpose &&
		state.inputHash === hashContent(request)
	);
}

/** Single-use approval state shared by 2025 and 2026-era clients. */
export function createApprovalController(): ApprovalController {
	const codec = createRequestStateCodec<ApprovalState>({
		key: randomBytes(32),
		ttlSeconds: APPROVAL_TTL_SECONDS,
		bind: (ctx) => ctx.mcpReq.method,
	});
	const pendingNonces = new Map<string, number>();

	function pruneExpiredNonces() {
		const now = Date.now();
		for (const [nonce, expiresAt] of pendingNonces) {
			if (expiresAt <= now) pendingNonces.delete(nonce);
		}
	}

	function reserveNonce() {
		pruneExpiredNonces();
		if (pendingNonces.size >= MAX_PENDING_APPROVALS) {
			throw new Error(
				"Too many pending approvals. Wait ten minutes for unused approvals to expire.",
			);
		}

		const nonce = randomUUID();
		pendingNonces.set(nonce, Date.now() + APPROVAL_TTL_SECONDS * 1000);
		return nonce;
	}

	/** Consumes the state's nonce and reports whether it was still pending. */
	function consumeNonce(state: ApprovalState | undefined) {
		pruneExpiredNonces();
		return state !== undefined && pendingNonces.delete(state.nonce);
	}

	async function requestApproval(
		request: ApprovalRequest,
		prompt: ApprovalPrompt,
		ctx: ServerContext,
	): Promise<ApprovalDecision> {
		const nonce = reserveNonce();
		const requestState = await codec.mint(
			{ purpose: request.purpose, nonce, inputHash: hashContent(request) },
			ctx,
		);
		return {
			kind: "input_required",
			response: inputRequired({
				inputRequests: { [prompt.key]: prompt.request },
				requestState,
			}),
		};
	}

	async function requireApproval(
		request: ApprovalRequest,
		ctx: ServerContext,
	): Promise<ApprovalDecision> {
		const prompt = approvalPrompt(request);
		const state = ApprovalStateSchema.safeParse(ctx.mcpReq.requestState()).data;
		const wasPending = consumeNonce(state);
		const response = inputResponse(ctx.mcpReq.inputResponses, prompt.key);

		if (response.kind === "missing") {
			return requestApproval(request, prompt, ctx);
		}
		if (response.kind !== "elicit" || response.action !== "accept") {
			return deniedDecision(prompt);
		}
		if (
			!prompt.isAccepted(ctx) ||
			!wasPending ||
			!stateMatchesRequest(state, request)
		) {
			return deniedDecision(prompt);
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
			if (decision.kind !== "approved") return decision;
			return { kind: "approved", authorization: { kind: "human", input } };
		},
	};
}
