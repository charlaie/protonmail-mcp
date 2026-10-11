import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ConfigSchema } from "./config.js";

const credentials = {
	PROTONMAIL_BRIDGE_USER: "me@example.com",
	PROTONMAIL_BRIDGE_PASSWORD: "test-password",
};

test("insecure TLS is restricted to literal loopback hosts, with localhost pinned to IPv4", () => {
	for (const host of [
		"127.0.0.1",
		"127.20.30.40",
		"::1",
		"localhost",
		"LOCALHOST",
	])
		assert.equal(
			ConfigSchema.safeParse({ ...credentials, PROTONMAIL_BRIDGE_HOST: host })
				.success,
			true,
		);
	for (const host of [
		"bridge.example.com",
		"192.168.1.2",
		"127.evil.example",
		"localhost.evil.example",
		"2130706433",
		"::ffff:192.168.1.2",
	])
		assert.equal(
			ConfigSchema.safeParse({ ...credentials, PROTONMAIL_BRIDGE_HOST: host })
				.success,
			false,
		);
	assert.equal(
		ConfigSchema.parse({ ...credentials, PROTONMAIL_BRIDGE_HOST: "localhost" })
			.host,
		"127.0.0.1",
	);
	assert.equal(
		ConfigSchema.parse({
			...credentials,
			PROTONMAIL_BRIDGE_HOST: "bridge.example.com",
			PROTONMAIL_TLS_REJECT_UNAUTHORIZED: "true",
		}).tlsRejectUnauthorized,
		true,
	);
	assert.deepEqual(
		ConfigSchema.parse({
			...credentials,
			PROTONMAIL_BRIDGE_OWN_ADDRESSES: "Alias@example.com,me@example.com",
		}).ownAddresses,
		["me@example.com", "alias@example.com"],
	);
});
