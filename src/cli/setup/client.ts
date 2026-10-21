import { writeFile } from "node:fs/promises";
import * as prompts from "@clack/prompts";
import {
	CLIENTS,
	type ClientName,
	ClientNameSchema,
	clientConfigSavedMessage,
	defaultClientConfigPath,
	installClientConfig,
	type LaunchSpecification,
	launchSpecification,
	prepareClientInstallation,
	renderClientConfig,
} from "../clients/configuration.js";
import { answer, confirm, requireNonBlank, validatedText } from "./prompts.js";

type ClientAction = "copy" | "save" | "install";

export async function configureClients(
	configPath: string,
	entryPath: string,
	serverName = "protonmail",
) {
	const clients = await answer(
		prompts.multiselect({
			message: "Which MCP clients should use this account?",
			options: ClientNameSchema.options.map((value) => ({
				value,
				label: CLIENTS[value].label,
			})),
			required: false,
		}),
	);
	const launch = launchSpecification({ configPath, entryPath });
	for (const client of clients)
		await configureClient(client, launch, serverName);
}

async function configureClient(
	client: ClientName,
	launch: LaunchSpecification,
	serverName: string,
) {
	const { label, instructions } = CLIENTS[client];
	const snippet = renderClientConfig(client, launch, serverName);
	prompts.note(snippet, `${label} configuration`);
	const action = await answer(
		prompts.select<ClientAction>({
			message: `Configure ${label}`,
			options: [
				{ value: "copy", label: "Use the displayed snippet" },
				{ value: "save", label: "Save a snippet to a new file" },
				{
					value: "install",
					label: "Merge into the client's configuration",
					hint: "Preview changes and keep a backup",
				},
			],
		}),
	);
	if (action === "save") await saveSnippet(snippet);
	else if (action === "install")
		await installIntoClient(client, launch, serverName);

	prompts.note(
		`${instructions}\nAfter connecting, ask the assistant to list your allowed mailboxes. Send approval and binary attachment handling have not been verified in this client.`,
		"Next step",
	);
}

async function saveSnippet(snippet: string) {
	const destination = await validatedText(
		"New snippet file path",
		"",
		requireNonBlank("Enter a file path."),
	);
	await writeFile(destination, snippet, { flag: "wx", mode: 0o600 });
	prompts.log.success(`Snippet saved to ${destination}.`);
}

async function installIntoClient(
	client: ClientName,
	launch: LaunchSpecification,
	serverName: string,
) {
	const path = await validatedText(
		"Client configuration file path",
		defaultClientConfigPath(client) ?? "",
		requireNonBlank(
			"Enter the path shown by the client's configuration editor.",
		),
	);
	const plan = await prepareClientInstallation(
		client,
		path,
		launch,
		serverName,
	);
	prompts.note(plan.updated, `Preview ${plan.path}`);

	const backupNotice =
		plan.original === null ? "" : " and back up the previous file";
	if (!(await confirm(`Save this configuration${backupNotice}?`, false)))
		return;
	const backup = await installClientConfig(plan);
	prompts.log.success(clientConfigSavedMessage(backup));
}
