import { resolve } from "node:path";
import * as prompts from "@clack/prompts";
import { launchSpecification } from "@/cli/clients/configuration.js";
import { checkMcpStartup } from "@/cli/diagnostics/mcp.js";
import { getDefaultStorage } from "@/config/paths.js";
import {
	commitSettings,
	readSettingsSnapshot,
	requirePolicyAccount,
} from "@/config/settings.js";
import {
	readServerConfig,
	resolveServerConfig,
	type ServerConfig,
} from "@/config/store.js";
import { loadReadPolicy } from "@/policy/store.js";
import { configureClients } from "./client.js";
import { configureConnection, verifyConnection } from "./connection.js";
import { configurePermissions, permissionReview } from "./permissions.js";
import { answer, requireTerminal, validatedText } from "./prompts.js";

export type SetupSection = "all" | "credentials" | "permissions" | "client";

async function configureStorage(
	configPath: string,
	existing: ServerConfig | null,
) {
	const { policyFile, operationsDirectory } =
		existing?.storage ?? getDefaultStorage(configPath);
	if (
		existing ||
		!(await answer(
			prompts.confirm({
				message: "Use existing custom policy or journal locations?",
				initialValue: false,
			}),
		))
	)
		return { policyFile, operationsDirectory };
	prompts.note(
		"If you previously used custom policy or operation-journal locations, enter those existing paths. Keep the journal to preserve replay protection. Relative paths resolve beside the server config file.",
		"Existing storage",
	);
	const required = (value: string) => {
		if (!value.trim()) throw new Error("Enter a path.");
	};
	return {
		policyFile: await validatedText("Access policy file", policyFile, required),
		operationsDirectory: await validatedText(
			"Operation journal directory",
			operationsDirectory,
			required,
		),
	};
}

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
	const expectedConfig = await readSettingsSnapshot(configPath);
	let existing: ServerConfig | null;
	try {
		existing = await readServerConfig(configPath);
	} catch (error) {
		prompts.log.warn(
			error instanceof Error ? error.message : "Invalid configuration.",
		);
		if (
			!(await answer(
				prompts.confirm({
					message: "Replace the invalid server configuration?",
					initialValue: false,
				}),
			))
		)
			return;
		existing = null;
	}
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
	let bridge = existing?.bridge;
	while (true) {
		if (section !== "permissions") bridge = await configureConnection(bridge);
		if (!bridge) throw new Error("Bridge credentials are missing.");
		const config = resolveServerConfig(
			{ version: 1, bridge, storage },
			resolve(configPath),
		);
		let mailboxes: Awaited<ReturnType<typeof verifyConnection>>;
		try {
			mailboxes = await (dependencies.verifyConnection ?? verifyConnection)(
				bridge,
			);
		} catch (error) {
			prompts.log.error(
				error instanceof Error ? error.message : "Bridge connection failed.",
			);
			if (
				section === "permissions" ||
				!(await answer(
					prompts.confirm({
						message: "Edit credentials and try again?",
						initialValue: true,
					}),
				))
			)
				return;
			bridge = undefined;
			continue;
		}
		const expectedPolicy = await readSettingsSnapshot(
			config.storage.policyFile,
		);
		let previous: Awaited<ReturnType<typeof loadReadPolicy>>;
		try {
			previous = await loadReadPolicy(config.storage.policyFile);
		} catch (error) {
			prompts.log.warn(
				error instanceof Error ? error.message : "Invalid access policy.",
			);
			if (
				!(await answer(
					prompts.confirm({
						message: "Replace the invalid access policy?",
						initialValue: false,
					}),
				))
			)
				return;
			previous = null;
		}
		if (previous && previous.version !== 3)
			prompts.log.warn(
				"This policy predates explicit tool grants. Mailbox and sender selections will be retained for this account; changes to mail require new grants.",
			);
		requirePolicyAccount(previous, bridge.user);
		const policy =
			section === "credentials" && previous?.version === 3
				? previous
				: await configurePermissions(bridge.user, mailboxes, previous);
		prompts.note(
			`${permissionReview(policy)}\n\nServer configuration: ${resolve(configPath)}\nPolicy: ${config.storage.policyFile}\nJournal: ${config.storage.operationsDirectory}\nBridge password: [hidden]`,
			"Review before saving",
		);
		if (
			!(await answer(
				prompts.confirm({
					message: "Save these settings and permissions?",
					initialValue: false,
				}),
			))
		)
			return;
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
		const progress = prompts.spinner();
		progress.start("Checking the generated MCP launch command.");
		try {
			progress.stop(
				await (dependencies.checkMcp ?? checkMcpStartup)(
					launchSpecification({ configPath: configPath, entryPath: entryPath }),
				),
			);
		} catch {
			progress.stop(
				"MCP startup could not be verified. Run protonmail-mcp doctor with this --config path.",
			);
		}
		if (section === "all")
			await configureClients(configPath, entryPath, serverName);
		prompts.outro("Setup complete. Keep Bridge running and signed in.");
		return;
	}
}
