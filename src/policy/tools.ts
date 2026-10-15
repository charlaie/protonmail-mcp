import { z } from "zod";

export const ToolNameSchema = z.enum([
	"list_mailboxes",
	"search_messages",
	"get_message",
	"get_thread",
	"list_attachments",
	"get_attachment",
	"get_inbox_capabilities",
	"manage_message",
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

type ToolDefinition = {
	label: string;
	group:
		| "Reading"
		| "Attachments"
		| "Drafts"
		| "Sending"
		| "Inbox"
		| "Recovery";
	changesMail: boolean;
	policyIndependent?: boolean;
};
export const TOOL_DEFINITIONS = {
	list_mailboxes: {
		label: "List mailboxes",
		group: "Reading",
		changesMail: false,
		policyIndependent: true,
	},
	search_messages: {
		label: "Search messages",
		group: "Reading",
		changesMail: false,
	},
	get_message: { label: "Read messages", group: "Reading", changesMail: false },
	get_thread: { label: "Read threads", group: "Reading", changesMail: false },
	list_attachments: {
		label: "List attachment metadata",
		group: "Attachments",
		changesMail: false,
	},
	get_attachment: {
		label: "Download attachments",
		group: "Attachments",
		changesMail: false,
	},
	get_draft: { label: "Read drafts", group: "Drafts", changesMail: false },
	create_draft: { label: "Create drafts", group: "Drafts", changesMail: true },
	create_reply_draft: {
		label: "Create reply drafts",
		group: "Drafts",
		changesMail: true,
	},
	edit_draft: { label: "Edit drafts", group: "Drafts", changesMail: true },
	send_email: {
		label: "Send new messages with approval",
		group: "Sending",
		changesMail: true,
	},
	send_draft: {
		label: "Send drafts with approval",
		group: "Sending",
		changesMail: true,
	},
	forward_email: {
		label: "Forward messages with approval",
		group: "Sending",
		changesMail: true,
	},
	get_inbox_capabilities: {
		label: "Inspect inbox capabilities",
		group: "Inbox",
		changesMail: false,
	},
	manage_message: {
		label: "Organize messages using selected actions",
		group: "Inbox",
		changesMail: true,
	},
	get_inbox_operation: {
		label: "Inspect inbox operation",
		group: "Recovery",
		changesMail: false,
		policyIndependent: true,
	},
	list_inbox_operations: {
		label: "List inbox operations",
		group: "Recovery",
		changesMail: false,
		policyIndependent: true,
	},
	reconcile_inbox_operation: {
		label: "Reconcile inbox operation",
		group: "Recovery",
		changesMail: false,
	},
	get_draft_operation: {
		label: "Inspect draft operation",
		group: "Recovery",
		changesMail: false,
		policyIndependent: true,
	},
	list_draft_operations: {
		label: "List draft operations",
		group: "Recovery",
		changesMail: false,
		policyIndependent: true,
	},
	reconcile_draft_operation: {
		label: "Reconcile draft operation",
		group: "Recovery",
		changesMail: false,
	},
	retry_draft_cleanup: {
		label: "Delete unchanged originals after draft edits",
		group: "Recovery",
		changesMail: true,
	},
	get_send_operation: {
		label: "Inspect send operation",
		group: "Recovery",
		changesMail: false,
		policyIndependent: true,
	},
	list_send_operations: {
		label: "List send operations",
		group: "Recovery",
		changesMail: false,
		policyIndependent: true,
	},
	retry_send_cleanup: {
		label: "Delete unchanged drafts after accepted sends",
		group: "Recovery",
		changesMail: true,
	},
	reconcile_send_operation: {
		label: "Reconcile send operation",
		group: "Recovery",
		changesMail: false,
	},
} satisfies Record<ToolName, ToolDefinition>;

export const READ_ONLY_TOOLS = ToolNameSchema.options.filter(
	(name) => !TOOL_DEFINITIONS[name].changesMail && name !== "get_attachment",
);

export function isPolicyIndependentTool(name: ToolName) {
	const definition = TOOL_DEFINITIONS[name];
	return "policyIndependent" in definition && definition.policyIndependent;
}
