#!/usr/bin/env node

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import type { ServerContext } from "@modelcontextprotocol/server";
import type { AttachmentApprovalInput } from "@/mail/access.js";
import type { SendApprovalInput } from "@/mail/sending/workflow.js";
import {
	type ApprovalController,
	createApprovalController,
} from "./elicitation.js";

type ApprovalDecision =
	| Awaited<ReturnType<ApprovalController["requireSendApproval"]>>
	| Awaited<ReturnType<ApprovalController["requireAttachmentApproval"]>>;

const acceptedSend = {
	approve_send: {
		action: "accept",
		content: { approve_send: true },
	},
};

const acceptedAttachment = {
	approve_attachment: {
		action: "accept",
		content: { approve_attachment: true },
	},
};

const original: SendApprovalInput = {
	operationId: randomUUID(),
	message: {
		from: "sender@example.com",
		media: [],
		cc: [],
		bcc: [],
		inReplyTo: [],
		references: [],
		to: ["recipient@example.com"],
		subject: "Original subject",
		text: `First paragraph\n\n${"x".repeat(1000)}\nFinal paragraph`,
	},
};

const changed: SendApprovalInput = {
	...original,
	message: { ...original.message, to: ["attacker@example.com"] },
};

const attachment: AttachmentApprovalInput = {
	bridgeUser: "bridge@example.com",
	policyFingerprint: "fixture-policy",
	attachment: {
		mailbox: "INBOX",
		uid: 1,
		uidValidity: "7",
		attachmentId: "2",
		filename: "scan.pdf",
		contentType: "application/pdf",
		mimeType: "application/pdf",
		size: 100,
		charset: undefined,
		senderEmails: ["trusted@example.com"],
		subject: "Invoice",
	},
};

function context(options?: {
	inputResponses?: Record<string, unknown>;
	requestState?: unknown;
}): ServerContext {
	return {
		mcpReq: {
			method: "tools/call",
			inputResponses: options?.inputResponses,
			requestState: () => options?.requestState,
		},
	} as unknown as ServerContext;
}

/** Asserts that a decision asks for input, then decodes the state it issued. */
async function issuedApproval(
	controller: ApprovalController,
	pending: Promise<ApprovalDecision>,
) {
	const decision = await pending;
	assert.equal(decision.kind, "input_required");
	const token = decision.response.requestState;
	assert.ok(typeof token === "string");
	return {
		prompt: JSON.stringify(decision.response.inputRequests),
		token,
		state: await controller.verifyRequestState(token, context()),
	};
}

async function runSendApprovalChecks() {
	const controller = createApprovalController();
	const requestSend = (input: SendApprovalInput, ctx = context()) =>
		controller.requireSendApproval(input, ctx);
	const requestAttachment = (ctx = context()) =>
		controller.requireAttachmentApproval(attachment, ctx);

	const injected = await requestSend(
		changed,
		context({ inputResponses: acceptedSend }),
	);
	assert.equal(injected.kind, "denied");

	const changedFlow = await issuedApproval(controller, requestSend(original));
	assert.ok(changedFlow.prompt.includes("sender@example.com"));
	assert.ok(
		changedFlow.prompt.includes(
			JSON.stringify(original.message.text).slice(1, -1),
		),
	);
	const changedResult = await requestSend(
		changed,
		context({ inputResponses: acceptedSend, requestState: changedFlow.state }),
	);
	assert.equal(changedResult.kind, "denied");

	const approvedFlow = await issuedApproval(controller, requestSend(original));
	const approvedContext = context({
		inputResponses: acceptedSend,
		requestState: approvedFlow.state,
	});
	assert.equal((await requestSend(original, approvedContext)).kind, "approved");
	assert.equal((await requestSend(original, approvedContext)).kind, "denied");

	const approvedToken = approvedFlow.token;
	const macStart = approvedToken.lastIndexOf(".") + 1;
	const replacement = approvedToken[macStart] === "A" ? "B" : "A";
	const tamperedToken = `${approvedToken.slice(0, macStart)}${replacement}${approvedToken.slice(macStart + 1)}`;
	await assert.rejects(
		controller.verifyRequestState(tamperedToken, context()),
		/mac/,
	);

	const attachmentFlow = await issuedApproval(controller, requestAttachment());
	const sendWithAttachmentState = await requestSend(
		original,
		context({
			requestState: attachmentFlow.state,
			inputResponses: acceptedSend,
		}),
	);
	assert.equal(sendWithAttachmentState.kind, "denied");

	const sendFlow = await issuedApproval(controller, requestSend(original));
	const attachmentWithSendState = await requestAttachment(
		context({
			requestState: sendFlow.state,
			inputResponses: acceptedAttachment,
		}),
	);
	assert.equal(attachmentWithSendState.kind, "denied");

	const expiringAttachment = await issuedApproval(
		controller,
		requestAttachment(),
	);
	const expiringSend = await issuedApproval(controller, requestSend(original));
	const originalNow = Date.now;
	const expiredTime = Date.now() + 11 * 60 * 1000;
	try {
		Date.now = () => expiredTime;
		const expiredSend = await requestSend(
			original,
			context({
				inputResponses: acceptedSend,
				requestState: expiringSend.state,
			}),
		);
		assert.equal(expiredSend.kind, "denied");

		const expiredAttachment = await requestAttachment(
			context({
				requestState: expiringAttachment.state,
				inputResponses: acceptedAttachment,
			}),
		);
		assert.equal(expiredAttachment.kind, "denied");
	} finally {
		Date.now = originalNow;
	}
}

await runSendApprovalChecks();
console.log("Send and attachment approval checks passed.");
