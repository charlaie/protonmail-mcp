import { z } from "zod";
import {
	GetMessageSchema,
	UidSchema,
	UidValiditySchema,
} from "../mail/identity.js";
import { OperationIdSchema } from "../operations/identity.js";
import {
	EmailAddressSchema,
	EmailListSchema,
	SubjectSchema,
	TextSchema,
} from "../outgoing/content.js";
import { MediaInputFields, withinMediaLimits } from "../outgoing/media.js";

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
export const EditDraftSchema = DraftPatchSchema.extend({
	uidValidity: UidValiditySchema,
	uid: UidSchema,
}).refine(withinMediaLimits, "Combined media exceeds 6 MiB or 20 parts.");
export const DraftIdSchema = z
	.uuid()
	.describe(
		"Stable logical draft ID returned by get_draft or a draft operation. Scoped to this account's journal and preserved across server-managed edits.",
	);
export const EditDraftRequestSchema = z.union([
	EditDraftSchema.strict(),
	DraftPatchSchema.extend({ draftId: DraftIdSchema })
		.strict()
		.refine(withinMediaLimits, "Combined media exceeds 6 MiB or 20 parts."),
]);

export const GetDraftSchema = z.union([
	GetMessageSchema.strict(),
	z.strictObject({ draftId: DraftIdSchema }),
]);
export type GetDraftInput = z.infer<typeof GetDraftSchema>;
export type EditDraftRequest = z.infer<typeof EditDraftRequestSchema>;

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
export type EditDraftInput = z.infer<typeof EditDraftSchema>;
