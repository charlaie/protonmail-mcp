import * as prompts from "@clack/prompts";
import type { ImapService } from "../bridge/imap.js";
import { MailboxCreationKindSchema } from "../inbox/creation.js";
import {
	InboxActionNameSchema,
	type InboxWritePolicy,
} from "../inbox/model.js";
import { createReadPolicy, type ReadPolicy } from "../policy/schema.js";
import {
	parseAttachmentExtensions,
	parseSenderDomains,
	parseSenderEmails,
} from "../policy/selection.js";
import {
	READ_ONLY_TOOLS,
	TOOL_DEFINITIONS,
	type ToolName,
	ToolNameSchema,
} from "../policy/tools.js";
import { inboxDestinations } from "./mailboxes.js";
import { answer, validatedText } from "./prompts.js";

const INBOX_ACTION_LABELS = {
	mark_read: "Mark as read",
	mark_unread: "Mark as unread",
	star: "Star",
	unstar: "Remove star",
	archive: "Archive",
	trash: "Move to Trash",
	move: "Move between folders",
	apply_label: "Apply existing labels",
	remove_label: "Remove labels and choose a destination folder",
} satisfies Record<(typeof InboxActionNameSchema.options)[number], string>;

export async function configurePermissions(
	account: string,
	mailboxes: Awaited<ReturnType<ImapService["listMailboxes"]>>,
	previous: ReadPolicy | null,
) {
	const existing =
		previous?.version !== 1 && previous?.bridgeUser === account
			? previous
			: null;
	const mode = await answer(
		prompts.select({
			message: "Choose an access mode",
			options: [
				{
					value: "readOnly",
					label: "Read-only",
					hint: "No draft changes, inbox changes, sending, or cleanup deletion",
				},
				{
					value: "custom",
					label: "Choose individual tools",
					hint: "Explicit grants for reading and changes",
				},
			],
			initialValue:
				existing?.version === 3 &&
				existing.allowedTools.some((name) => TOOL_DEFINITIONS[name].changesMail)
					? "custom"
					: "readOnly",
		}),
	);
	const choices = ToolNameSchema.options.filter(
		(name) => mode !== "readOnly" || !TOOL_DEFINITIONS[name].changesMail,
	);
	let allowedTools = ToolNameSchema.array().parse(
		await answer(
			prompts.autocompleteMultiselect<string>({
				message: "Which tools may the assistant use?",
				options: choices.map((name) => ({
					value: name,
					label: TOOL_DEFINITIONS[name].label,
					hint: `${TOOL_DEFINITIONS[name].group} · ${name}`,
				})),
				initialValues: (existing?.version === 3
					? existing.allowedTools
					: READ_ONLY_TOOLS
				).filter((name) => choices.includes(name)),
				required: false,
			}),
		),
	);
	const requiresDrafts = allowedTools.some((name) =>
		[
			"create_draft",
			"create_reply_draft",
			"edit_draft",
			"send_draft",
			"get_draft",
			"retry_draft_cleanup",
			"retry_send_cleanup",
			"reconcile_draft_operation",
		].includes(name),
	);
	const drafts = mailboxes.find(
		(mailbox) =>
			mailbox.specialUse === "\\Drafts" ||
			mailbox.flags.includes("\\Drafts") ||
			mailbox.path === "Drafts",
	);
	if (requiresDrafts && !drafts)
		throw new Error(
			"Draft tools were selected, but Bridge did not return a Drafts mailbox. Check the account or disable those tools.",
		);
	const initialMailboxes = existing?.allowedMailboxes ?? ["INBOX"];
	let allowedMailboxes = await answer(
		prompts.autocompleteMultiselect({
			message: "Which mailboxes may the assistant read?",
			options: mailboxes.map((mailbox) => ({
				value: mailbox.path,
				label: mailbox.path,
				hint: mailbox.specialUse ?? undefined,
			})),
			initialValues: [
				...new Set([
					...initialMailboxes,
					...(requiresDrafts && drafts ? [drafts.path] : []),
				]),
			].filter((name) => mailboxes.some((mailbox) => mailbox.path === name)),
			required: true,
		}),
	);
	while (requiresDrafts && drafts && !allowedMailboxes.includes(drafts.path)) {
		prompts.log.error(
			`The selected draft tools need read access to ${drafts.path}. Include it below or cancel and change the tool selection.`,
		);
		allowedMailboxes = await answer(
			prompts.autocompleteMultiselect({
				message: "Readable mailboxes, including the required Drafts mailbox",
				options: mailboxes.map((mailbox) => ({
					value: mailbox.path,
					label: mailbox.path,
				})),
				initialValues: allowedMailboxes,
				required: true,
			}),
		);
	}
	const restrictSenders = await answer(
		prompts.confirm({
			message: "Restrict readable messages to selected senders or domains?",
			initialValue: Boolean(
				existing?.allowedSenderEmails.length ||
					existing?.allowedSenderDomains.length,
			),
		}),
	);
	let allowedSenderEmails: string[] = [];
	let allowedSenderDomains: string[] = [];
	if (restrictSenders) {
		if (requiresDrafts)
			prompts.note(
				"Sender restrictions also apply to drafts. Include your own sender addresses or domains if you want to read and edit drafts sent from them.",
				"Draft sender access",
			);
		while (true) {
			allowedSenderEmails = parseSenderEmails(
				await validatedText(
					"Allowed sender email addresses, comma-separated",
					existing?.allowedSenderEmails.join(", ") ?? "",
					parseSenderEmails,
				),
			);
			allowedSenderDomains = parseSenderDomains(
				await validatedText(
					"Allowed sender domains, comma-separated. Addresses OR exact domains match.",
					existing?.allowedSenderDomains.join(", ") ?? "",
					parseSenderDomains,
				),
			);
			if (allowedSenderEmails.length || allowedSenderDomains.length) break;
			prompts.log.error(
				"Enter at least one email address or domain to restrict senders.",
			);
		}
	}
	let allowedAttachmentExtensions: ReturnType<
		typeof parseAttachmentExtensions
	> = [];
	let requireAttachmentApproval = false;
	if (allowedTools.includes("get_attachment")) {
		const attachmentMode = await answer(
			prompts.select({
				message: "Which attachments may be downloaded?",
				options: [
					{ value: "disabled", label: "Disabled" },
					{ value: "selected", label: "Selected extensions" },
					{ value: "all", label: "All files, including extensionless files" },
				],
				initialValue: existing?.allowedAttachmentExtensions.includes("*")
					? "all"
					: existing?.allowedAttachmentExtensions.length
						? "selected"
						: "disabled",
			}),
		);
		if (attachmentMode === "all") allowedAttachmentExtensions = ["*"];
		else if (attachmentMode === "selected")
			allowedAttachmentExtensions = parseAttachmentExtensions(
				await validatedText(
					"Extensions, comma-separated, for example .pdf,.txt,.zip",
					existing?.allowedAttachmentExtensions.join(",") || ".pdf,.txt",
					(value) => {
						const entries = parseAttachmentExtensions(value);
						if (!entries.length || entries.includes("*"))
							throw new Error(
								"Enter selected extensions with leading dots, or choose All files.",
							);
					},
				),
			);
		if (allowedAttachmentExtensions.length)
			requireAttachmentApproval = await answer(
				prompts.confirm({
					message: "Require approval before each attachment download?",
					initialValue: existing?.requireAttachmentApproval ?? true,
				}),
			);
		else
			allowedTools = allowedTools.filter((name) => name !== "get_attachment");
	}
	let inboxWrites: InboxWritePolicy = { mode: "disabled" };
	const mailboxCreation = allowedTools.includes("create_mailbox")
		? await answer(
				prompts.multiselect({
					message:
						"Which kinds of mailboxes may the assistant create? Reading or moving mail into new mailboxes still requires separate grants.",
					options: MailboxCreationKindSchema.options.map((value) => ({
						value,
						label: value === "folder" ? "Custom folders" : "Labels",
					})),
					initialValues: existing?.mailboxCreation ?? [],
					required: true,
				}),
			)
		: [];
	if (allowedTools.includes("manage_message")) {
		const actions = await answer(
			prompts.multiselect({
				message: "Which inbox actions may run without a per-action approval?",
				options: InboxActionNameSchema.options.map((value) => ({
					value,
					label: INBOX_ACTION_LABELS[value],
				})),
				initialValues:
					existing?.inboxWrites.mode === "enabled"
						? existing.inboxWrites.actions
						: [],
				required: true,
			}),
		);
		const requiredDestinations = inboxDestinations(actions, mailboxes);
		const missingReads = requiredDestinations.filter(
			(path) => !allowedMailboxes.includes(path),
		);
		if (missingReads.length) {
			if (
				!(await answer(
					prompts.confirm({
						message: `These actions need read and write access to ${missingReads.join(", ")}. Add those readable mailboxes?`,
						initialValue: false,
					}),
				))
			)
				throw new Error(
					"Inbox actions were not granted. Run setup again to change the selections.",
				);
			allowedMailboxes.push(...missingReads);
		}
		const writable = allowedMailboxes.filter((name) => name !== drafts?.path);
		if (!writable.length)
			throw new Error(
				"Inbox actions require at least one readable non-Drafts mailbox.",
			);
		let selected = await answer(
			prompts.autocompleteMultiselect({
				message:
					"Writable source and destination mailboxes. Include Archive or Trash if those actions are enabled.",
				options: writable.map((value) => ({ value, label: value })),
				initialValues: [
					...new Set([
						...requiredDestinations,
						...(existing?.inboxWrites.mode === "enabled"
							? existing.inboxWrites.mailboxes.filter((name) =>
									writable.includes(name),
								)
							: []),
					]),
				],
				required: true,
			}),
		);
		while (requiredDestinations.some((path) => !selected.includes(path))) {
			prompts.log.error(
				`Include the required destination mailboxes: ${requiredDestinations.join(", ")}.`,
			);
			selected = await answer(
				prompts.autocompleteMultiselect({
					message: "Writable source and destination mailboxes",
					options: writable.map((value) => ({ value, label: value })),
					initialValues: selected,
					required: true,
				}),
			);
		}
		inboxWrites = { mode: "enabled", actions, mailboxes: selected };
	}
	return createReadPolicy({
		bridgeUser: account,
		allowedTools,
		allowedMailboxes,
		allowedSenderEmails,
		allowedSenderDomains,
		allowedAttachmentExtensions,
		requireAttachmentApproval,
		inboxWrites,
		mailboxCreation,
		createdAt: existing?.createdAt,
	});
}

export function permissionReview(policy: ReturnType<typeof createReadPolicy>) {
	return [
		`Account: ${policy.bridgeUser}`,
		`Readable mailboxes: ${policy.allowedMailboxes.join(", ")}`,
		`Senders: ${policy.allowedSenderEmails.length || policy.allowedSenderDomains.length ? [...policy.allowedSenderEmails, ...policy.allowedSenderDomains].join(", ") : "All senders in selected mailboxes"}`,
		`Attachments: ${policy.allowedAttachmentExtensions.join(", ") || "Disabled"}`,
		`Attachment approval: ${policy.allowedAttachmentExtensions.length ? (policy.requireAttachmentApproval ? "Every download" : "Not required") : "Not applicable"}`,
		`Inbox changes: ${policy.inboxWrites.mode === "enabled" ? `${policy.inboxWrites.actions.join(", ")} in ${policy.inboxWrites.mailboxes.join(", ")}` : "Disabled"}`,
		`Mailbox creation: ${policy.mailboxCreation.join(", ") || "Disabled"}. New mailboxes need separate read and message-write grants.`,
		"Enabled tools:",
		...policy.allowedTools.map(
			(name: ToolName) => `  ${TOOL_DEFINITIONS[name].label} (${name})`,
		),
		"All unlisted tools are disabled. Sending always requires approval of the complete message.",
	].join("\n");
}
