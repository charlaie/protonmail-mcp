import { summarizeReadPolicy } from "../policy/enforcement.js";
import {
	hasReadPolicyFile,
	loadReadPolicy,
	resetReadPolicy,
} from "../policy/store.js";
import { confirm, requireTerminal } from "./setup/prompts.js";

export async function runPolicyCommand(path: string) {
	const policy = await loadReadPolicy(path);
	if (!policy) {
		console.log(
			`No access policy at ${path}. Run protonmail-mcp setup --section permissions with this configuration.`,
		);
		return;
	}
	console.log(JSON.stringify(summarizeReadPolicy(policy), null, 2));
}

export async function runResetPolicyCommand(path: string) {
	if (!(await hasReadPolicyFile(path))) {
		console.log(`No access policy at ${path}. Nothing to reset.`);
		return;
	}
	requireTerminal();
	const approved = await confirm(
		`Remove the access policy at ${path}? All mail access will be disabled until setup is run again. The journal is kept.`,
		false,
	);
	if (!approved) return;
	await resetReadPolicy(path);
	console.log("Access policy reset. The operation journal was preserved.");
}
