import { writeFile } from "node:fs/promises";
import * as prompts from "@clack/prompts";
import {
	CLIENTS,
	ClientNameSchema,
	defaultClientConfigPath,
	installClientConfig,
	launchSpecification,
	prepareClientInstallation,
	renderClientConfig,
} from "@/cli/clients/configuration.js";
import { answer, validatedText } from "./prompts.js";

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
	const launch = launchSpecification({
		configPath: configPath,
		entryPath: entryPath,
	});
	for (const client of clients) {
		const snippet = renderClientConfig(client, launch, serverName);
		prompts.note(snippet, `${CLIENTS[client].label} configuration`);
		const action = await answer(
			prompts.select({
				message: `Configure ${CLIENTS[client].label}`,
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
		if (action === "save") {
			const destination = await validatedText(
				"New snippet file path",
				"",
				(value) => {
					if (!value.trim()) throw new Error("Enter a file path.");
				},
			);
			await writeFile(destination, snippet, { flag: "wx", mode: 0o600 });
			prompts.log.success(`Snippet saved to ${destination}.`);
		} else if (action === "install") {
			const path = await validatedText(
				"Client configuration file path",
				defaultClientConfigPath(client) ?? "",
				(value) => {
					if (!value.trim())
						throw new Error(
							"Enter the path shown by the client's configuration editor.",
						);
				},
			);
			const plan = await prepareClientInstallation(
				client,
				path,
				launch,
				serverName,
			);
			prompts.note(plan.updated, `Preview ${plan.path}`);
			if (
				await answer(
					prompts.confirm({
						message: `Save this configuration${plan.original === null ? "" : " and back up the previous file"}?`,
						initialValue: false,
					}),
				)
			) {
				const backup = await installClientConfig(plan);
				prompts.log.success(
					`Client configuration saved.${backup ? ` Backup: ${backup}` : ""}`,
				);
			}
		}
		prompts.note(
			`${CLIENTS[client].instructions}\nAfter connecting, ask the assistant to list your allowed mailboxes. Send approval and binary attachment handling have not been verified in this client.`,
			"Next step",
		);
	}
}
