import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { type ReadPolicy, ReadPolicySchema } from "../policy/schema.js";
import {
	isMissingFile,
	stagePrivateFile,
	writePrivateFile,
} from "../shared/private-file.js";
import { resolveServerConfig, type ServerConfig } from "./store.js";

export async function readSettingsSnapshot(
	path: string,
): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (isMissingFile(error)) return null;
		throw error;
	}
}

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
// This handles write failures, not a process crash between the two renames.
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
	requirePolicyAccount(policy, config.bridge.user);
	const policyPath = config.storage.policyFile;
	const locks: string[] = [];
	const staged: string[] = [];
	try {
		for (const path of [configPath, policyPath].sort()) {
			await mkdir(dirname(path), { recursive: true, mode: 0o700 });
			const lockPath = `${path}.setup.lock`;
			try {
				const lock = await open(lockPath, "wx", 0o600);
				locks.push(lockPath);
				await lock.close();
			} catch (error) {
				throw new Error(
					`Cannot lock settings at ${lockPath}. Another setup may be running; remove a stale lock only after confirming it has stopped.`,
					{ cause: error },
				);
			}
		}
		const [currentConfig, currentPolicy] = await Promise.all([
			readSettingsSnapshot(configPath),
			readSettingsSnapshot(policyPath),
		]);
		if (
			currentConfig !== input.expectedConfig ||
			currentPolicy !== input.expectedPolicy
		)
			throw new Error(
				"Settings changed during setup. Run setup again to review the current values before saving.",
			);
		if (currentPolicy !== null) {
			// Invalid policies can be replaced after explicit review in the wizard.
			let previous: ReadPolicy | null = null;
			try {
				previous = ReadPolicySchema.parse(JSON.parse(currentPolicy));
			} catch {}
			requirePolicyAccount(previous, config.bridge.user);
		}
		const stagedConfig = await stagePrivateFile(
			configPath,
			`${JSON.stringify(config, null, 2)}\n`,
		);
		staged.push(stagedConfig);
		const stagedPolicy = await stagePrivateFile(
			policyPath,
			`${JSON.stringify(policy, null, 2)}\n`,
		);
		staged.push(stagedPolicy);
		await replace(stagedPolicy, policyPath);
		try {
			await replace(stagedConfig, configPath);
		} catch (error) {
			try {
				if (currentPolicy === null) await rm(policyPath, { force: true });
				else await writePrivateFile(policyPath, currentPolicy);
			} catch (restoreError) {
				throw new AggregateError(
					[error, restoreError],
					`Configuration save failed and policy restoration failed at ${policyPath}. Restore its previous settings before using this server.`,
				);
			}
			throw error;
		}
	} finally {
		await Promise.all(
			[...staged, ...locks].map((path) => rm(path, { force: true })),
		);
	}
}
