import { resolve } from "node:path";
import * as prompts from "@clack/prompts";
import type { BridgeConfig } from "@/bridge/config.js";
import {
	type LaunchSpecification,
	launchSpecification,
} from "@/cli/clients/configuration.js";
import { checkMcpStartup } from "@/cli/diagnostics/mcp.js";
import { getDefaultStorage } from "@/config/paths.js";
import { commitSettings, requirePolicyAccount } from "@/config/settings.js";
import {
	readServerConfig,
	resolveServerConfig,
	type ServerConfig,
} from "@/config/store.js";
import { loadReadPolicy } from "@/policy/store.js";
import { readOptionalTextFile } from "@/shared/private-file.js";
import { configureClients } from "./client.js";
import { configureConnection, verifyConnection } from "./connection.js";
import type { BridgeMailboxes } from "./mailboxes.js";
import { configurePermissions, permissionReview } from "./permissions.js";
import {
	confirm,
	requireNonBlank,
	requireTerminal,
	validatedText,
} from "./prompts.js";

export type SetupSection = "all" | "credentials" | "permissions" | "client";
type Storage = ServerConfig["storage"];
type ConfiguredPolicy = Awaited<ReturnType<typeof configurePermissions>>;

/** `declined` means the user kept an invalid file, which ends setup without saving. */
type LoadedFile<T> =
	| { status: "loaded"; value: T | null }
	| { status: "declined" };

type VerifiedConnection = { config: ServerConfig; mailboxes: BridgeMailboxes };

export async function runSetupCommand({
	configPath,
	entryPath,
	section = "all",
	serverName = "protonmail",
	dependencies = {},
}: {
	configPath: string;
	entryPath: string;
	section?: SetupSection;
	serverName?: string;
	dependencies?: {
		verifyConnection?: typeof verifyConnection;
		checkMcp?: typeof checkMcpStartup;
	};
}) {
	requireTerminal();
	prompts.intro("Proton Mail MCP setup");
	const expectedConfig = await readOptionalTextFile(configPath);
	const loadedConfig = await loadReplaceable(
		() => readServerConfig(configPath),
		{
			fallbackWarning: "Invalid configuration.",
			replacePrompt: "Replace the invalid server configuration?",
		},
	);
	if (loadedConfig.status === "declined") return;
	const existing = loadedConfig.value;

	if (section === "client") {
		if (!existing)
			throw new Error(
				"Configure this account first with protonmail-mcp setup.",
			);
		await configureClients(configPath, entryPath, serverName);
		return;
	}
	if (section === "permissions" && !existing)
		throw new Error(
			"Configure Bridge credentials first with protonmail-mcp setup.",
		);

	const storage = await configureStorage(configPath, existing);
	const connection = await connectToBridge({
		configPath,
		section,
		storage,
		bridge: existing?.bridge,
		verify: dependencies.verifyConnection ?? verifyConnection,
	});
	if (!connection) return;

	const { config, mailboxes } = connection;
	const policyFile = config.storage.policyFile;
	const expectedPolicy = await readOptionalTextFile(policyFile);
	const policy = await choosePolicy(section, config, mailboxes);
	if (!policy) return;

	prompts.note(
		settingsReview(policy, configPath, config.storage),
		"Review before saving",
	);
	if (!(await confirm("Save these settings and permissions?", false))) return;
	await commitSettings({
		configPath,
		config,
		policy,
		expectedConfig,
		expectedPolicy,
	});
	prompts.log.success(
		"Configuration and access policy saved. Restart running MCP servers to refresh tool visibility.",
	);

	await reportMcpStartup(
		launchSpecification({ configPath, entryPath }),
		dependencies.checkMcp ?? checkMcpStartup,
	);
	if (section === "all")
		await configureClients(configPath, entryPath, serverName);
	prompts.outro("Setup complete. Keep Bridge running and signed in.");
}

async function loadReplaceable<T>(
	load: () => Promise<T | null>,
	messages: { fallbackWarning: string; replacePrompt: string },
): Promise<LoadedFile<T>> {
	try {
		return { status: "loaded", value: await load() };
	} catch (error) {
		prompts.log.warn(errorMessage(error, messages.fallbackWarning));
	}
	if (!(await confirm(messages.replacePrompt, false)))
		return { status: "declined" };
	return { status: "loaded", value: null };
}

async function configureStorage(
	configPath: string,
	existing: ServerConfig | null,
): Promise<Storage> {
	const { policyFile, operationsDirectory } =
		existing?.storage ?? getDefaultStorage(configPath);
	if (existing) return { policyFile, operationsDirectory };
	if (
		!(await confirm("Use existing custom policy or journal locations?", false))
	)
		return { policyFile, operationsDirectory };

	prompts.note(
		"If you previously used custom policy or operation-journal locations, enter those existing paths. Keep the journal to preserve replay protection. Relative paths resolve beside the server config file.",
		"Existing storage",
	);
	const requirePath = requireNonBlank("Enter a path.");
	return {
		policyFile: await validatedText(
			"Access policy file",
			policyFile,
			requirePath,
		),
		operationsDirectory: await validatedText(
			"Operation journal directory",
			operationsDirectory,
			requirePath,
		),
	};
}

async function connectToBridge(input: {
	configPath: string;
	section: SetupSection;
	storage: Storage;
	bridge: BridgeConfig | undefined;
	verify: typeof verifyConnection;
}): Promise<VerifiedConnection | null> {
	const { configPath, section, storage, verify } = input;
	let bridge = input.bridge;
	while (true) {
		if (section !== "permissions") bridge = await configureConnection(bridge);
		if (!bridge) throw new Error("Bridge credentials are missing.");
		const config = resolveServerConfig(
			{ version: 1, bridge, storage },
			resolve(configPath),
		);
		try {
			return { config, mailboxes: await verify(bridge) };
		} catch (error) {
			prompts.log.error(errorMessage(error, "Bridge connection failed."));
		}

		if (section === "permissions") return null;
		if (!(await confirm("Edit credentials and try again?", true))) return null;
		bridge = undefined;
	}
}

async function choosePolicy(
	section: SetupSection,
	config: ServerConfig,
	mailboxes: BridgeMailboxes,
): Promise<ConfiguredPolicy | null> {
	const account = config.bridge.user;
	const loadedPolicy = await loadReplaceable(
		() => loadReadPolicy(config.storage.policyFile),
		{
			fallbackWarning: "Invalid access policy.",
			replacePrompt: "Replace the invalid access policy?",
		},
	);
	if (loadedPolicy.status === "declined") return null;
	const previous = loadedPolicy.value;

	if (previous && previous.version !== 3)
		prompts.log.warn(
			"This policy predates explicit tool grants. Mailbox and sender selections will be retained for this account; changes to mail require new grants.",
		);
	requirePolicyAccount(previous, account);
	if (section === "credentials" && previous?.version === 3) return previous;
	return configurePermissions(account, mailboxes, previous);
}

function settingsReview(
	policy: ConfiguredPolicy,
	configPath: string,
	storage: Storage,
) {
	return [
		permissionReview(policy),
		"",
		`Server configuration: ${resolve(configPath)}`,
		`Policy: ${storage.policyFile}`,
		`Journal: ${storage.operationsDirectory}`,
		"Bridge password: [hidden]",
	].join("\n");
}

async function reportMcpStartup(
	launch: LaunchSpecification,
	checkMcp: typeof checkMcpStartup,
) {
	const progress = prompts.spinner();
	progress.start("Checking the generated MCP launch command.");
	try {
		progress.stop(await checkMcp(launch));
	} catch {
		progress.stop(
			"MCP startup could not be verified. Run protonmail-mcp doctor with this --config path.",
		);
	}
}

function errorMessage(error: unknown, fallback: string) {
	return error instanceof Error ? error.message : fallback;
}
