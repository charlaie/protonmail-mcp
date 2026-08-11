#!/usr/bin/env node

import { strict as assert } from "node:assert";
import type { ServerContext } from "@modelcontextprotocol/server";
import { createSendApprovalController } from "./elicitation.js";
import type { SendEmailInput } from "./schemas.js";

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
	const original: SendEmailInput = {
		to: ["recipient@example.com"],
		subject: "Original subject",
		text: "Original body",
	};
	const changed: SendEmailInput = {
		...original,
		to: ["attacker@example.com"],
	};

	const injected = await controller.requireApproval(
		changed,
		context({ inputResponses: approvedInputResponses }),
	);
	assert.equal(injected.kind, "denied");

	const changedFlow = await controller.requireApproval(original, context());
	assert.equal(changedFlow.kind, "input_required");
	assert.equal(typeof changedFlow.response.requestState, "string");
	const changedState = changedFlow.response.requestState as string;
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
	assert.equal(typeof approvedFlow.response.requestState, "string");
	const approvedState = approvedFlow.response.requestState as string;
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
}

await runSendApprovalChecks();
console.log("Send approval checks passed.");
