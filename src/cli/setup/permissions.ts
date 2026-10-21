import * as prompts from "@clack/prompts";
import type { AttachmentPermission } from "../../mail/attachments/formats.js";
import { MailboxCreationKindSchema } from "../../mail/inbox/creation.js";
import {
	InboxActionNameSchema,
	type InboxWritePolicy,
} from "../../mail/inbox/model.js";
import { findSpecialMailbox } from "../../mail/mailboxes.js";
import { createReadPolicy, type ReadPolicy } from "../../policy/schema.js";
import {
	parseAttachmentExtensions,
	parseSenderDomains,
	parseSenderEmails,
} from "../../policy/selection.js";
import {
	READ_ONLY_TOOLS,
	TOOL_DEFINITIONS,
	type ToolName,
	ToolNameSchema,
} from "../../policy/tools.js";
import { type BridgeMailboxes, inboxDestinations } from "./mailboxes.js";
import { answer, confirm, validatedText } from "./prompts.js";

type InboxActionName = (typeof InboxActionNameSchema.options)[number];
type MailboxCreationKind = (typeof MailboxCreationKindSchema.options)[number];

type EnabledInboxWrites = Extract<InboxWritePolicy, { mode: "enabled" }>;

type ExistingPolicy = Exclude<ReadPolicy, { version: 1 }> | null;

type GranularPolicy = ReturnType<typeof createReadPolicy>;
type AccessMode = "custom" | "readOnly";
type AttachmentMode = "disabled" | "selected" | "all";

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
} satisfies Record<InboxActionName, string>;

const MAILBOX_CREATION_LABELS = {
	folder: "Custom folders",
	label: "Labels",
} satisfies Record<MailboxCreationKind, string>;

const DRAFT_MAILBOX_TOOLS: readonly ToolName[] = [
	"create_draft",
	"create_reply_draft",
	"edit_draft",
	"send_draft",
	"get_draft",
	"retry_draft_cleanup",
	"retry_send_cleanup",
	"reconcile_draft_operation",
];

const NO_ATTACHMENTS = {
	allowedAttachmentExtensions: [],
	requireAttachmentApproval: false,
};

export async function configurePermissions(
	account: string,
	mailboxes: BridgeMailboxes,
	previous: ReadPolicy | null,
): Promise<GranularPolicy> {
	const existing =
		previous?.version !== 1 && previous?.bridgeUser === account
			? previous
			: null;
	const selectedTools = await chooseTools(existing);
	const draftsPath = findSpecialMailbox(mailboxes, "drafts")?.path;
	const draftPaths = requiredDraftPaths(selectedTools, draftsPath);

	const readableMailboxes = await chooseMailboxes({
		message: "Which mailboxes may the assistant read?",
		mailboxes,
		initialValues: existing?.allowedMailboxes ?? ["INBOX"],
		requiredPaths: draftPaths,
	});
	const senders = await chooseSenders(existing, draftPaths.length > 0);
	const attachments = await chooseAttachments(existing, selectedTools);
	const allowedTools = attachments.allowedAttachmentExtensions.length
		? selectedTools
		: selectedTools.filter((name) => name !== "get_attachment");
	const mailboxCreation = await chooseMailboxCreation(existing, allowedTools);
	const inbox = await chooseInboxWrites({
		existing,
		allowedTools,
		readableMailboxes,
		mailboxes,
		draftsPath,
	});

	return createReadPolicy({
		bridgeUser: account,
		allowedTools,
		...senders,
		...attachments,
		...inbox,
		mailboxCreation,
		createdAt: existing?.createdAt,
	});
}

function requiredDraftPaths(
	selectedTools: readonly ToolName[],
	draftsPath: string | undefined,
): string[] {
	if (!selectedTools.some((name) => DRAFT_MAILBOX_TOOLS.includes(name)))
		return [];
	if (!draftsPath)
		throw new Error(
			"Draft tools were selected, but Bridge did not return a Drafts mailbox. Check the account or disable those tools.",
		);
	return [draftsPath];
}

async function chooseMailboxes(input: {
	message: string;
	mailboxes: { path: string; specialUse?: string }[];
	initialValues: string[];
	requiredPaths: string[];
}) {
	const options = input.mailboxes.map((mailbox) => ({
		value: mailbox.path,
		label: mailbox.path,
		hint: mailbox.specialUse,
	}));
	let selected = [
		...new Set([...input.initialValues, ...input.requiredPaths]),
	].filter((path) => input.mailboxes.some((mailbox) => mailbox.path === path));

	while (true) {
		selected = await answer(
			prompts.autocompleteMultiselect({
				message: input.message,
				options,
				initialValues: selected,
				required: true,
			}),
		);
		const missing = input.requiredPaths.filter(
			(path) => !selected.includes(path),
		);
		if (!missing.length) return selected;

		prompts.log.error(
			`The selected tools require these mailboxes: ${missing.join(", ")}. Include them or cancel and change the tool selection.`,
		);
	}
}

async function chooseTools(existing: ExistingPolicy): Promise<ToolName[]> {
	const mode = await answer(
		prompts.select<AccessMode>({
			message: "Choose an access mode",
			options: [
				{
					value: "custom",
					label: "Choose individual tools",
					hint: "All tools selected by default for new accounts",
				},
				{
					value: "readOnly",
					label: "Read-only",
					hint: "No draft changes, inbox changes, sending, or cleanup deletion",
				},
			],
			initialValue: initialAccessMode(existing),
		}),
	);
	const choices = ToolNameSchema.options.filter(
		(name) => mode !== "readOnly" || !TOOL_DEFINITIONS[name].changesMail,
	);
	const initialValues = defaultToolSelection(existing, mode, choices).filter(
		(name) => choices.includes(name),
	);

	const selected = await answer(
		prompts.groupMultiselect<string>({
			message: "Which tools may the assistant use?",
			options: groupToolOptions(choices),
			initialValues,
			required: false,
		}),
	);
	return ToolNameSchema.array().parse(selected);
}

function initialAccessMode(existing: ExistingPolicy): AccessMode {
	if (!existing) return "custom";
	const grantsMailChanges =
		existing.version === 3 &&
		existing.allowedTools.some((name) => TOOL_DEFINITIONS[name].changesMail);
	return grantsMailChanges ? "custom" : "readOnly";
}

function defaultToolSelection(
	existing: ExistingPolicy,
	mode: AccessMode,
	choices: readonly ToolName[],
): readonly ToolName[] {
	if (existing?.version === 3) return existing.allowedTools;
	return mode === "readOnly" ? READ_ONLY_TOOLS : choices;
}

function groupToolOptions(choices: readonly ToolName[]) {
	const groups: prompts.GroupMultiSelectOptions<string>["options"] = {};
	const groupOrder = new Set(
		Object.values(TOOL_DEFINITIONS).map((definition) => definition.group),
	);
	for (const group of groupOrder) {
		const options = choices
			.filter((name) => TOOL_DEFINITIONS[name].group === group)
			.map((name) => ({
				value: name,
				label: TOOL_DEFINITIONS[name].label,
				hint: name,
			}));
		if (options.length) groups[group] = options;
	}
	return groups;
}

async function chooseSenders(
	existing: ExistingPolicy,
	requiresDrafts: boolean,
) {
	const restrictSenders = await confirm(
		"Restrict readable messages to selected senders or domains?",
		Boolean(
			existing?.allowedSenderEmails.length ||
				existing?.allowedSenderDomains.length,
		),
	);
	if (!restrictSenders)
		return { allowedSenderEmails: [], allowedSenderDomains: [] };

	if (requiresDrafts)
		prompts.note(
			"Sender restrictions also apply to drafts. Include your own sender addresses or domains if you want to read and edit drafts sent from them.",
			"Draft sender access",
		);
	while (true) {
		const allowedSenderEmails = parseSenderEmails(
			await validatedText(
				"Allowed sender email addresses, comma-separated",
				existing?.allowedSenderEmails.join(", ") ?? "",
				parseSenderEmails,
			),
		);
		const allowedSenderDomains = parseSenderDomains(
			await validatedText(
				"Allowed sender domains, comma-separated. Addresses OR exact domains match.",
				existing?.allowedSenderDomains.join(", ") ?? "",
				parseSenderDomains,
			),
		);
		if (allowedSenderEmails.length || allowedSenderDomains.length)
			return { allowedSenderEmails, allowedSenderDomains };

		prompts.log.error(
			"Enter at least one email address or domain to restrict senders.",
		);
	}
}

async function chooseAttachments(
	existing: ExistingPolicy,
	selectedTools: readonly ToolName[],
): Promise<{
	allowedAttachmentExtensions: AttachmentPermission[];
	requireAttachmentApproval: boolean;
}> {
	if (!selectedTools.includes("get_attachment")) return NO_ATTACHMENTS;

	const mode = await answer(
		prompts.select<AttachmentMode>({
			message: "Which attachments may be downloaded?",
			options: [
				{ value: "disabled", label: "Disabled" },
				{ value: "selected", label: "Selected extensions" },
				{ value: "all", label: "All files, including extensionless files" },
			],
			initialValue: initialAttachmentMode(existing),
		}),
	);
	const allowedAttachmentExtensions = await chooseAttachmentExtensions(
		mode,
		existing,
	);
	if (!allowedAttachmentExtensions.length) return NO_ATTACHMENTS;

	const requireAttachmentApproval = await confirm(
		"Require approval before each attachment download?",
		existing?.requireAttachmentApproval ?? true,
	);
	return { allowedAttachmentExtensions, requireAttachmentApproval };
}

function initialAttachmentMode(existing: ExistingPolicy): AttachmentMode {
	if (!existing || existing.allowedAttachmentExtensions.includes("*"))
		return "all";
	return existing.allowedAttachmentExtensions.length ? "selected" : "disabled";
}

async function chooseAttachmentExtensions(
	mode: AttachmentMode,
	existing: ExistingPolicy,
): Promise<AttachmentPermission[]> {
	switch (mode) {
		case "disabled":
			return [];
		case "all":
			return ["*"];
		case "selected":
			return parseAttachmentExtensions(
				await validatedText(
					"Extensions, comma-separated, for example .pdf,.txt,.zip",
					existing?.allowedAttachmentExtensions.join(",") || ".pdf,.txt",
					requireSelectedExtensions,
				),
			);
	}
}

function requireSelectedExtensions(value: string) {
	const extensions = parseAttachmentExtensions(value);
	if (!extensions.length || extensions.includes("*"))
		throw new Error(
			"Enter selected extensions with leading dots, or choose All files.",
		);
}

async function chooseMailboxCreation(
	existing: ExistingPolicy,
	allowedTools: readonly ToolName[],
): Promise<MailboxCreationKind[]> {
	if (!allowedTools.includes("create_mailbox")) return [];

	return answer(
		prompts.multiselect({
			message:
				"Which kinds of mailboxes may the assistant create? Reading or moving mail into new mailboxes still requires separate grants.",
			options: MailboxCreationKindSchema.options.map((value) => ({
				value,
				label: MAILBOX_CREATION_LABELS[value],
			})),
			initialValues:
				existing?.mailboxCreation ?? MailboxCreationKindSchema.options,
			required: true,
		}),
	);
}

async function chooseInboxWrites(input: {
	existing: ExistingPolicy;
	allowedTools: readonly ToolName[];
	readableMailboxes: string[];
	mailboxes: BridgeMailboxes;
	draftsPath: string | undefined;
}): Promise<{ inboxWrites: InboxWritePolicy; allowedMailboxes: string[] }> {
	const { existing, mailboxes, draftsPath } = input;
	if (!input.allowedTools.includes("manage_message"))
		return {
			inboxWrites: { mode: "disabled" },
			allowedMailboxes: input.readableMailboxes,
		};

	const actions = await answer(
		prompts.multiselect({
			message: "Which inbox actions may run without a per-action approval?",
			options: InboxActionNameSchema.options.map((value) => ({
				value,
				label: INBOX_ACTION_LABELS[value],
			})),
			initialValues: initialInboxSelection(
				existing,
				(writes) => writes.actions,
				InboxActionNameSchema.options,
			),
			required: true,
		}),
	);
	const destinations = inboxDestinations(actions, mailboxes);
	const allowedMailboxes = await addDestinationReads(
		input.readableMailboxes,
		destinations,
	);
	const writable = allowedMailboxes.filter((path) => path !== draftsPath);
	if (!writable.length)
		throw new Error(
			"Inbox actions require at least one readable non-Drafts mailbox.",
		);

	const writableMailboxes = await chooseMailboxes({
		message:
			"Writable source and destination mailboxes. Include Archive or Trash if those actions are enabled.",
		mailboxes: writable.map((path) => ({ path })),
		requiredPaths: destinations,
		initialValues: initialInboxSelection(
			existing,
			(writes) => writes.mailboxes,
			writable,
		),
	});
	return {
		inboxWrites: { mode: "enabled", actions, mailboxes: writableMailboxes },
		allowedMailboxes,
	};
}

/** New accounts start from every option; existing accounts keep their saved inbox grants. */
function initialInboxSelection<T>(
	existing: ExistingPolicy,
	saved: (writes: EnabledInboxWrites) => T[],
	defaults: T[],
): T[] {
	if (existing?.inboxWrites.mode === "enabled")
		return saved(existing.inboxWrites);
	return existing ? [] : defaults;
}

async function addDestinationReads(
	readableMailboxes: string[],
	destinations: string[],
) {
	const missingReads = destinations.filter(
		(path) => !readableMailboxes.includes(path),
	);
	if (!missingReads.length) return readableMailboxes;

	const addReads = await confirm(
		`These actions need read and write access to ${missingReads.join(", ")}. Add those readable mailboxes?`,
		false,
	);
	if (!addReads)
		throw new Error(
			"Inbox actions were not granted. Run setup again to change the selections.",
		);
	return [...readableMailboxes, ...missingReads];
}

export function permissionReview(policy: GranularPolicy) {
	return [
		`Account: ${policy.bridgeUser}`,
		`Readable mailboxes: ${policy.allowedMailboxes.join(", ")}`,
		`Senders: ${describeSenders(policy)}`,
		`Attachments: ${policy.allowedAttachmentExtensions.join(", ") || "Disabled"}`,
		`Attachment approval: ${describeAttachmentApproval(policy)}`,
		`Inbox changes: ${describeInboxWrites(policy.inboxWrites)}`,
		`Mailbox creation: ${policy.mailboxCreation.join(", ") || "Disabled"}. New mailboxes need separate read and message-write grants.`,
		"Enabled tools:",
		...policy.allowedTools.map(
			(name) => `  ${TOOL_DEFINITIONS[name].label} (${name})`,
		),
		"All unlisted tools are disabled. Sending always requires approval of the complete message.",
	].join("\n");
}

function describeSenders(policy: GranularPolicy) {
	const senders = [
		...policy.allowedSenderEmails,
		...policy.allowedSenderDomains,
	];
	return senders.length
		? senders.join(", ")
		: "All senders in selected mailboxes";
}

function describeAttachmentApproval(policy: GranularPolicy) {
	if (!policy.allowedAttachmentExtensions.length) return "Not applicable";
	return policy.requireAttachmentApproval ? "Every download" : "Not required";
}

function describeInboxWrites(inboxWrites: InboxWritePolicy) {
	if (inboxWrites.mode === "disabled") return "Disabled";
	return `${inboxWrites.actions.join(", ")} in ${inboxWrites.mailboxes.join(", ")}`;
}
