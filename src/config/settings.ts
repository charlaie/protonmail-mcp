import { rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { type ReadPolicy, ReadPolicySchema } from "../policy/schema.js";
import {
	readOptionalTextFile,
	stagePrivateFile,
	writePrivateFile,
} from "../shared/private-file.js";
import { withSettingsLocks } from "./locks.js";
import { resolveServerConfig, type ServerConfig } from "./store.js";

export function requirePolicyAccount(
	policy: ReadPolicy | null,
	account: string,
) {
	if (policy && policy.version !== 1 && policy.bridgeUser !== account)
		throw new Error(
			"This policy belongs to another Bridge account. Use a separate --config file and policy location; keep existing journals for replay protection.",
		);
}

// The wizard reviews snapshots, then commits under exclusive locks. Both files
// are validated and staged first; a failed config replacement restores policy.
// A crash between the two renames is not rolled back. It leaves the reviewed
// policy beside the previous config, and the runtime refuses a policy bound to
// another account, so no combination grants access that was never reviewed.
export async function commitSettings(
	input: {
		configPath: string;
		config: ServerConfig;
		policy: ReadPolicy;
		expectedConfig: string | null;
		expectedPolicy: string | null;
	},
	replace: typeof rename = rename,
) {
	const configPath = resolve(input.configPath);
	const config = resolveServerConfig(input.config, configPath);
	const policy = ReadPolicySchema.parse(input.policy);
	const account = config.bridge.user;
	requirePolicyAccount(policy, account);
	const policyPath = config.storage.policyFile;

	return withSettingsLocks([configPath, policyPath], async () => {
		const staged: string[] = [];
		try {
			const [currentConfig, currentPolicy] = await Promise.all([
				readOptionalTextFile(configPath),
				readOptionalTextFile(policyPath),
			]);
			if (
				currentConfig !== input.expectedConfig ||
				currentPolicy !== input.expectedPolicy
			)
				throw new Error(
					"Settings changed during setup. Run setup again to review the current values before saving.",
				);
			requireStoredPolicyAccount(currentPolicy, account);

			const stagedConfig = await stagePrivateFile(configPath, toJson(config));
			staged.push(stagedConfig);
			const stagedPolicy = await stagePrivateFile(policyPath, toJson(policy));
			staged.push(stagedPolicy);

			await replace(stagedPolicy, policyPath);
			try {
				await replace(stagedConfig, configPath);
			} catch (error) {
				await restorePolicy(policyPath, currentPolicy, error);
				throw error;
			}
		} finally {
			await Promise.all(staged.map((path) => rm(path, { force: true })));
		}
	});
}

/** An unparseable stored policy may be replaced; the wizard already asked to replace it. */
function requireStoredPolicyAccount(contents: string | null, account: string) {
	if (contents === null) return;
	let stored: ReadPolicy | null = null;
	try {
		stored = ReadPolicySchema.parse(JSON.parse(contents));
	} catch {}
	requirePolicyAccount(stored, account);
}

async function restorePolicy(
	policyPath: string,
	previousPolicy: string | null,
	configError: unknown,
) {
	try {
		if (previousPolicy === null) await rm(policyPath, { force: true });
		else await writePrivateFile(policyPath, previousPolicy);
	} catch (restoreError) {
		throw new AggregateError(
			[configError, restoreError],
			`Configuration save failed and policy restoration failed at ${policyPath}. Restore its previous settings before using this server.`,
		);
	}
}

function toJson(value: unknown) {
	return `${JSON.stringify(value, null, 2)}\n`;
}
