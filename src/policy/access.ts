import { MailError } from "../shared/mail-error.js";
import { readPolicyStatus } from "./enforcement.js";
import type { ReadPolicy } from "./schema.js";
import { loadReadPolicy, loadReadPolicySync } from "./store.js";
import { isPolicyIndependentTool, type ToolName } from "./tools.js";

export function canUseTool(
	policy: ReadPolicy | null,
	account: string,
	name: ToolName,
) {
	if (!policy || policy.version !== 3 || policy.bridgeUser !== account)
		return isPolicyIndependentTool(name);
	return policy.allowedTools.includes(name);
}

export function requireToolPermission(
	policy: ReadPolicy | null,
	account: string,
	name: ToolName,
) {
	if (canUseTool(policy, account, name)) return;
	const status = readPolicyStatus(policy, account);
	throw new MailError(
		status === "not_configured"
			? "POLICY_NOT_CONFIGURED"
			: status === "account_mismatch"
				? "ACCOUNT_MISMATCH"
				: "POLICY_DENIED",
		`Tool ${name} is disabled by the local access policy${status !== "ok" ? ` (${status})` : ""}. Run protonmail-mcp setup --section permissions for this configuration.`,
		"configure",
	);
}

export function createToolAccess(account: string, policyFile?: string) {
	let initialPolicy: ReadPolicy | null;
	try {
		initialPolicy = loadReadPolicySync(policyFile);
	} catch {
		initialPolicy = null;
	}
	return {
		visible: (name: ToolName) => canUseTool(initialPolicy, account, name),
		async require(name: ToolName) {
			let policy: ReadPolicy | null;
			try {
				policy = await loadReadPolicy(policyFile);
			} catch (error) {
				if (isPolicyIndependentTool(name)) return;
				throw error;
			}
			requireToolPermission(policy, account, name);
		},
	};
}

export type ToolAccess = ReturnType<typeof createToolAccess>;
