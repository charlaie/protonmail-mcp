import { z } from "zod";
import {
	type GetMessageInput,
	GetMessageSchema,
	MailboxSchema,
	UidSchema,
	UidValiditySchema,
} from "@/mail/identity.js";
import {
	EmailAddressSchema,
	EmailListSchema,
	SubjectSchema,
	TextSchema,
} from "@/mail/outgoing/content.js";
import {
	MediaInputFields,
	withinMediaLimits,
} from "@/mail/outgoing/media/model.js";
import { OperationIdSchema } from "@/operations/identity.js";

const DraftContentSchema = z
	.object({
		...MediaInputFields,
		from: EmailAddressSchema.optional(),
		to: EmailListSchema.optional().describe("Optional primary recipients."),
		cc: EmailListSchema.optional().describe("Optional CC recipients."),
		bcc: EmailListSchema.optional().describe("Optional BCC recipients."),
		subject: SubjectSchema.default("").describe(
			"Draft subject line. May be blank for an unfinished draft.",
		),
		text: TextSchema.default("").describe(
			"Plain-text draft body. Optional attachments and inlineImages are separate fields. Arbitrary HTML authoring is unsupported.",
		),
	})
	.refine(withinMediaLimits, "Combined media exceeds 6 MiB or 20 parts.");

export const CreateDraftSchema = DraftContentSchema.safeExtend({
	operationId: OperationIdSchema,
});

const PatchRecipientsSchema = z
	.union([EmailAddressSchema, z.array(EmailAddressSchema)])
	.transform((value) => (Array.isArray(value) ? value : [value]));
const DraftPatchSchema = z.object({
	...MediaInputFields,
	operationId: OperationIdSchema,
	expectedRevision: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.describe("Revision returned by get_draft. Rejects stale edits."),
	to: PatchRecipientsSchema.optional().describe(
		"Omit to preserve; [] clears recipients.",
	),
	cc: PatchRecipientsSchema.optional(),
	bcc: PatchRecipientsSchema.optional(),
	subject: SubjectSchema.optional(),
	text: TextSchema.optional(),
});
export const DraftIdSchema = z
	.uuid()
	.describe(
		"Stable logical draft ID returned by get_draft or a draft operation. Scoped to this account's journal and preserved across server-managed edits.",
	);

type DraftPatch = z.output<typeof DraftPatchSchema>;
export type GetDraftInput = { draftId: string } | GetMessageInput;
export type EditDraftRequest =
	| (DraftPatch & { draftId: string })
	| (DraftPatch & { uid: number; uidValidity: string });

/**
 * Some hosts rewrite top-level input unions into free text, so each draft
 * request is one object that accepts exactly one locator form.
 */
export function requireOneDraftLocator(physicalFields: readonly string[]) {
	const physical = physicalFields.join(", ");
	return (value: Record<string, unknown>, context: z.RefinementCtx) => {
		const given = physicalFields.filter((field) => value[field] !== undefined);
		const valid =
			value.draftId === undefined
				? given.length === physicalFields.length
				: given.length === 0;
		if (!valid)
			context.addIssue({
				code: "custom",
				message: `Provide either draftId or all of ${physical}, not both.`,
			});
	};
}

const locatorDescription = (fields: string) =>
	`Use with ${fields} when draftId is omitted.`;

export const EditDraftRequestSchema = DraftPatchSchema.extend({
	draftId: DraftIdSchema.optional(),
	uidValidity: UidValiditySchema.optional().describe(locatorDescription("uid")),
	uid: UidSchema.optional().describe(locatorDescription("uidValidity")),
})
	.strict()
	.refine(withinMediaLimits, "Combined media exceeds 6 MiB or 20 parts.")
	.superRefine(requireOneDraftLocator(["uid", "uidValidity"]))
	.transform(
		({ draftId, uid, uidValidity, ...patch }): EditDraftRequest =>
			draftId === undefined
				? {
						...patch,
						uid: UidSchema.parse(uid),
						uidValidity: UidValiditySchema.parse(uidValidity),
					}
				: { ...patch, draftId },
	);

export const DraftLocatorSchema = z
	.strictObject({
		draftId: DraftIdSchema.optional(),
		mailbox: MailboxSchema.optional().describe(
			locatorDescription("uid and uidValidity"),
		),
		uidValidity: UidValiditySchema.optional(),
		uid: UidSchema.optional(),
	})
	.superRefine(requireOneDraftLocator(["mailbox", "uid", "uidValidity"]));

export const GetDraftSchema = DraftLocatorSchema.transform(
	({ draftId, ...identity }): GetDraftInput =>
		draftId === undefined ? GetMessageSchema.parse(identity) : { draftId },
);

export const CreateReplyDraftSchema = GetMessageSchema.extend({
	...MediaInputFields,
	from: EmailAddressSchema.optional(),
	operationId: OperationIdSchema,
	replyAll: z
		.boolean()
		.default(false)
		.describe(
			"Include the original To and Cc recipients, excluding configured own addresses. Original Bcc recipients are never copied.",
		),
	text: TextSchema.default("").describe(
		"Plain-text reply body. May be empty for an unfinished reply draft.",
	),
}).refine(withinMediaLimits, "Combined media exceeds 6 MiB or 20 parts.");

export type CreateDraftInput = z.infer<typeof CreateDraftSchema>;
export type EditDraftInput = DraftPatch & { uid: number; uidValidity: string };
