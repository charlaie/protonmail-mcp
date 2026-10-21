import { MailError } from "../shared/mail-error.js";
import { readPolicyStatus } from "./enforcement.js";
import type { ReadPolicy } from "./schema.js";
import { loadReadPolicy, loadReadPolicySync } from "./store.js";
import { isPolicyIndependentTool, type ToolName } from "./tools.js";

type PolicyStatus = ReturnType<typeof readPolicyStatus>;

export function canUseTool(
	policy: ReadPolicy | null,
	account: string,
	name: ToolName,
) {
	if (!policy || policy.version !== 3 || policy.bridgeUser !== account)
		return isPolicyIndependentTool(name);
	return policy.allowedTools.includes(name);
}

function toolDeniedCode(status: PolicyStatus) {
	switch (status) {
		case "not_configured":
			return "POLICY_NOT_CONFIGURED";
		case "account_mismatch":
			return "ACCOUNT_MISMATCH";
		default:
			return "POLICY_DENIED";
	}
}

export function requireToolPermission(
	policy: ReadPolicy | null,
	account: string,
	name: ToolName,
) {
	if (canUseTool(policy, account, name)) return;

	const status = readPolicyStatus(policy, account);
	const statusDetail = status === "ok" ? "" : ` (${status})`;
	throw new MailError(
		toolDeniedCode(status),
		`Tool ${name} is disabled by the local access policy${statusDetail}. Run protonmail-mcp setup --section permissions for this configuration.`,
		"configure",
	);
}

// Tool visibility is advisory; an unreadable policy hides every policy-dependent tool.
function loadVisibilityPolicy(policyFile: string | undefined) {
	try {
		return loadReadPolicySync(policyFile);
	} catch {
		return null;
	}
}

export function createToolAccess(account: string, policyFile?: string) {
	const visibilityPolicy = loadVisibilityPolicy(policyFile);

	return {
		visible: (name: ToolName) => canUseTool(visibilityPolicy, account, name),

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
