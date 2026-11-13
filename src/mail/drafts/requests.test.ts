import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { SendDraftRequestSchema } from "@/mail/sending/requests.js";
import { EditDraftRequestSchema, GetDraftSchema } from "./requests.js";

const draftId = randomUUID();
const physical = { uid: 4, uidValidity: "7" };

test("draft locators accept exactly one form and parse to the matching shape", () => {
	assert.deepEqual(GetDraftSchema.parse({ draftId }), { draftId });
	assert.deepEqual(GetDraftSchema.parse({ mailbox: "Drafts", ...physical }), {
		mailbox: "Drafts",
		...physical,
	});
	for (const input of [
		{},
		{ draftId, mailbox: "Drafts", ...physical },
		{ draftId, uid: 4 },
		{ mailbox: "Drafts", uid: 4 },
		{ draftId, extra: true },
	])
		assert.equal(GetDraftSchema.safeParse(input).success, false);

	const patch = {
		operationId: randomUUID(),
		expectedRevision: "0".repeat(64),
		text: "Changed",
	};
	const byId = EditDraftRequestSchema.parse({ ...patch, draftId });
	assert.equal("uid" in byId, false);
	assert.equal(byId.text, "Changed");
	const byIdentity = EditDraftRequestSchema.parse({ ...patch, ...physical });
	assert.equal("draftId" in byIdentity, false);
	for (const input of [
		patch,
		{ ...patch, draftId, ...physical },
		{ ...patch, uid: 4 },
		{ ...patch, mailbox: "Drafts", ...physical },
	])
		assert.equal(EditDraftRequestSchema.safeParse(input).success, false);

	const operationId = randomUUID();
	assert.deepEqual(SendDraftRequestSchema.parse({ operationId, draftId }), {
		operationId,
		draftId,
	});
	assert.deepEqual(SendDraftRequestSchema.parse({ operationId, ...physical }), {
		operationId,
		...physical,
	});
	for (const input of [
		{ operationId },
		{ operationId, draftId, ...physical },
		{ operationId, uidValidity: "7" },
	])
		assert.equal(SendDraftRequestSchema.safeParse(input).success, false);
});
