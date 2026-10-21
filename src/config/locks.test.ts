import { strict as assert } from "node:assert";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withSettingsLocks } from "./locks.js";

test("failed multi-file acquisition releases only its own locks and never runs the update", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "protonmail-settings-locks-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const first = join(directory, "a.json");
	const second = join(directory, "b.json");
	await withSettingsLocks([second], async () => {
		await assert.rejects(
			withSettingsLocks([second, first], async () => {
				assert.fail("A partially locked update must not run");
			}),
			/Cannot lock settings/,
		);
		assert.deepEqual(await readdir(directory), ["b.json.setup.lock"]);
	});
	assert.deepEqual(await readdir(directory), []);
});

test("settings locks normalize repeated paths and release locks after the update fails", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "protonmail-settings-locks-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "settings.json");
	const failure = new Error("Update failed");
	await assert.rejects(
		withSettingsLocks([path, `${directory}/./settings.json`], async () => {
			assert.deepEqual(await readdir(directory), ["settings.json.setup.lock"]);
			throw failure;
		}),
		(error) => error === failure,
	);
	assert.deepEqual(await readdir(directory), []);
	assert.equal(await withSettingsLocks([path], async () => "saved"), "saved");
});
