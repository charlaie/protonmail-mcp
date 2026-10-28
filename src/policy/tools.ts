import { z } from "zod";

export const ToolNameSchema = z.enum([
	"list_mailboxes",
	"search_messages",
	"get_message",
	"batch_get_messages",
	"get_thread",
	"list_attachments",
	"get_attachment",
	"get_inbox_capabilities",
	"manage_message",
	"create_mailbox",
	"get_inbox_operation",
	"list_inbox_operations",
	"reconcile_inbox_operation",
	"create_draft",
	"create_reply_draft",
	"get_draft",
	"edit_draft",
	"get_draft_operation",
	"list_draft_operations",
	"reconcile_draft_operation",
	"retry_draft_cleanup",
	"send_email",
	"send_draft",
	"forward_email",
	"get_send_operation",
	"list_send_operations",
	"retry_send_cleanup",
	"reconcile_send_operation",
]);

export type ToolName = z.infer<typeof ToolNameSchema>;

type ToolGroup =
	| "Reading"
	| "Attachments"
	| "Drafts"
	| "Sending"
	| "Inbox"
	| "Recovery";

type ToolDefinition = {
	label: string;
	group: ToolGroup;
	changesMail: boolean;
	policyIndependent?: boolean;
};

function readTool(label: string, group: ToolGroup): ToolDefinition {
	return { label, group, changesMail: false };
}

function mailChangingTool(label: string, group: ToolGroup): ToolDefinition {
	return { label, group, changesMail: true };
}

// Policy-independent tools stay usable without a valid policy for this account.
function policyIndependentTool(
	label: string,
	group: ToolGroup,
): ToolDefinition {
	return { label, group, changesMail: false, policyIndependent: true };
}

export const TOOL_DEFINITIONS = {
	list_mailboxes: policyIndependentTool("List mailboxes", "Reading"),
	search_messages: readTool("Search messages", "Reading"),
	batch_get_messages: readTool("Read a batch of messages", "Reading"),
	get_message: readTool("Read messages", "Reading"),
	get_thread: readTool("Read threads", "Reading"),
	list_attachments: readTool("List attachment metadata", "Attachments"),
	get_attachment: readTool("Download attachments", "Attachments"),
	get_draft: readTool("Read drafts", "Drafts"),
	create_draft: mailChangingTool("Create drafts", "Drafts"),
	create_reply_draft: mailChangingTool("Create reply drafts", "Drafts"),
	edit_draft: mailChangingTool("Edit drafts", "Drafts"),
	send_email: mailChangingTool("Send new messages with approval", "Sending"),
	send_draft: mailChangingTool("Send drafts with approval", "Sending"),
	forward_email: mailChangingTool("Forward messages with approval", "Sending"),
	get_inbox_capabilities: readTool("Inspect inbox capabilities", "Inbox"),
	manage_message: mailChangingTool(
		"Organize messages using selected actions",
		"Inbox",
	),
	create_mailbox: mailChangingTool(
		"Create folders and labels using selected kinds",
		"Inbox",
	),
	get_inbox_operation: policyIndependentTool(
		"Inspect inbox operation",
		"Recovery",
	),
	list_inbox_operations: policyIndependentTool(
		"List inbox operations",
		"Recovery",
	),
	reconcile_inbox_operation: readTool("Reconcile inbox operation", "Recovery"),
	get_draft_operation: policyIndependentTool(
		"Inspect draft operation",
		"Recovery",
	),
	list_draft_operations: policyIndependentTool(
		"List draft operations",
		"Recovery",
	),
	reconcile_draft_operation: readTool("Reconcile draft operation", "Recovery"),
	retry_draft_cleanup: mailChangingTool(
		"Delete unchanged originals after draft edits",
		"Recovery",
	),
	get_send_operation: policyIndependentTool(
		"Inspect send operation",
		"Recovery",
	),
	list_send_operations: policyIndependentTool(
		"List send operations",
		"Recovery",
	),
	retry_send_cleanup: mailChangingTool(
		"Delete unchanged drafts after accepted sends",
		"Recovery",
	),
	reconcile_send_operation: readTool("Reconcile send operation", "Recovery"),
} satisfies Record<ToolName, ToolDefinition>;

export const READ_ONLY_TOOLS = ToolNameSchema.options.filter(
	(name) => !TOOL_DEFINITIONS[name].changesMail && name !== "get_attachment",
);

export function isPolicyIndependentTool(name: ToolName) {
	return TOOL_DEFINITIONS[name].policyIndependent === true;
}
