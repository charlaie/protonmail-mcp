import { strict as assert } from "node:assert";
import { test } from "node:test";
import { listPage } from "./list-page.js";

test("list byte pages retain exact identifiers and make progress", () => {
	const paths = ["x".repeat(40_000), "y".repeat(40_000)];
	assert.deepEqual(listPage(paths, { limit: 20, offset: 0 }), {
		items: [paths[0]],
		nextOffset: 1,
	});
	assert.deepEqual(listPage(paths, { limit: 20, offset: 1 }), {
		items: [paths[1]],
		nextOffset: null,
	});
	assert.deepEqual(listPage([], { limit: 20, offset: 0 }), {
		items: [],
		nextOffset: null,
	});
	assert.throws(
		() => listPage(["x".repeat(70_000)], { limit: 20, offset: 0 }),
		/64 KiB/,
	);
});
