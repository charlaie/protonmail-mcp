import { strict as assert } from "node:assert";
import { test } from "node:test";
import { findSpecialMailbox } from "./mailboxes.js";

test("special mailboxes prefer declared roles over conventional names in any list order", () => {
	for (const [role, fallback, flag] of [
		["drafts", "Drafts", "\\Drafts"],
		["sent", "Sent", "\\Sent"],
		["archive", "Archive", "\\Archive"],
		["trash", "Trash", "\\Trash"],
	] as const) {
		const conventional = { path: fallback, flags: [] };
		for (const declared of [
			{ path: `Localized/${fallback}`, specialUse: flag, flags: [] },
			{ path: `Localized/${fallback}`, flags: new Set([flag]) },
		]) {
			assert.equal(
				findSpecialMailbox([conventional, declared], role),
				declared,
			);
			assert.equal(
				findSpecialMailbox([declared, conventional], role),
				declared,
			);
		}
	}
});

test("special mailboxes exclude non-selectable namespaces from role and name matching", () => {
	const namespace = {
		path: "Drafts",
		specialUse: "\\Drafts",
		flags: ["\\Noselect"],
	};
	const selectable = { path: "My Drafts", flags: ["\\Drafts"] };
	assert.equal(
		findSpecialMailbox([namespace, selectable], "drafts"),
		selectable,
	);
	assert.equal(findSpecialMailbox([namespace], "drafts"), undefined);
	assert.equal(findSpecialMailbox([], "drafts"), undefined);
	const fallback = { path: "Drafts", flags: [] };
	assert.equal(findSpecialMailbox([fallback], "drafts"), fallback);
});
