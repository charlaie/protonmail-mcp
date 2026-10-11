#!/usr/bin/env node

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import type { ServerContext } from "@modelcontextprotocol/server";
import type { SendApprovalInput } from "./elicitation.js";
import { createSendApprovalController } from "./elicitation.js";

const approvedInputResponses = {
	approve_send: {
		action: "accept",
		content: { approve_send: true },
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

async function runSendApprovalChecks() {
	const controller = createSendApprovalController();
	const original: SendApprovalInput = {
		operationId: randomUUID(),
		message: {
			from: "sender@example.com",
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

	const injected = await controller.requireApproval(
		changed,
		context({ inputResponses: approvedInputResponses }),
	);
	assert.equal(injected.kind, "denied");

	const changedFlow = await controller.requireApproval(original, context());
	assert.equal(changedFlow.kind, "input_required");
	const changedState = changedFlow.response.requestState;
	assert.ok(typeof changedState === "string");
	const serializedPrompt = JSON.stringify(changedFlow.response.inputRequests);
	assert.ok(serializedPrompt.includes("sender@example.com"));
	assert.ok(
		serializedPrompt.includes(
			JSON.stringify(original.message.text).slice(1, -1),
		),
	);
	const decodedChangedState = await controller.verifyRequestState(
		changedState,
		context(),
	);
	const changedResult = await controller.requireApproval(
		changed,
		context({
			inputResponses: approvedInputResponses,
			requestState: decodedChangedState,
		}),
	);
	assert.equal(changedResult.kind, "denied");

	const approvedFlow = await controller.requireApproval(original, context());
	assert.equal(approvedFlow.kind, "input_required");
	const approvedState = approvedFlow.response.requestState;
	assert.ok(typeof approvedState === "string");
	const decodedApprovedState = await controller.verifyRequestState(
		approvedState,
		context(),
	);
	const approved = await controller.requireApproval(
		original,
		context({
			inputResponses: approvedInputResponses,
			requestState: decodedApprovedState,
		}),
	);
	assert.equal(approved.kind, "approved");

	const replayed = await controller.requireApproval(
		original,
		context({
			inputResponses: approvedInputResponses,
			requestState: decodedApprovedState,
		}),
	);
	assert.equal(replayed.kind, "denied");

	const macStart = approvedState.lastIndexOf(".") + 1;
	const replacement = approvedState[macStart] === "A" ? "B" : "A";
	const tamperedState = `${approvedState.slice(0, macStart)}${replacement}${approvedState.slice(macStart + 1)}`;
	await assert.rejects(
		controller.verifyRequestState(tamperedState, context()),
		/mac/,
	);

	const expiredFlow = await controller.requireApproval(original, context());
	assert.equal(expiredFlow.kind, "input_required");
	const expiredToken = expiredFlow.response.requestState;
	assert.ok(typeof expiredToken === "string");
	const expiredState = await controller.verifyRequestState(
		expiredToken,
		context(),
	);
	const originalNow = Date.now;
	const expiredTime = Date.now() + 11 * 60 * 1000;
	try {
		Date.now = () => expiredTime;
		const expired = await controller.requireApproval(
			original,
			context({
				inputResponses: approvedInputResponses,
				requestState: expiredState,
			}),
		);
		assert.equal(expired.kind, "denied");
	} finally {
		Date.now = originalNow;
	}
}

await runSendApprovalChecks();
console.log("Send approval checks passed.");
