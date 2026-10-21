import { z } from "zod";
import { DraftIdSchema } from "@/mail/drafts/requests.js";
import {
	GetMessageSchema,
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

export const SendEmailSchema = z
	.object({
		...MediaInputFields,
		operationId: OperationIdSchema,
		from: EmailAddressSchema.optional(),
		to: EmailListSchema.describe("Primary recipients for the email."),
		cc: EmailListSchema.optional().describe("Optional CC recipients."),
		bcc: EmailListSchema.optional().describe("Optional BCC recipients."),
		subject: SubjectSchema.min(1).describe(
			"Email subject line. Keep it concise and specific.",
		),
		text: TextSchema.min(1).describe(
			"Plain-text email body. Optional attachments and inlineImages are separate fields. Images use generated HTML with a text alternative.",
		),
	})
	.refine(withinMediaLimits, "Combined media exceeds 6 MiB or 20 parts.");

export const ForwardEmailSchema = z
	.object({
		...SendEmailSchema.shape,
		source: GetMessageSchema.describe(
			"Original message whose allowed headers and plain text are quoted. Original attachments are not included automatically.",
		),
		text: TextSchema.default("").describe(
			"Optional introduction before the forwarded message.",
		),
		subject: SubjectSchema.optional().describe(
			"Optional subject. Defaults to Fwd: plus the original subject.",
		),
	})
	.refine(withinMediaLimits, "Combined media exceeds 6 MiB or 20 parts.");

export const SendDraftSchema = z.object({
	operationId: OperationIdSchema,
	uidValidity: UidValiditySchema,
	uid: UidSchema,
});
export const SendDraftRequestSchema = z.union([
	SendDraftSchema.strict(),
	z.strictObject({
		operationId: OperationIdSchema,
		draftId: DraftIdSchema,
	}),
]);

export type SendEmailInput = z.infer<typeof SendEmailSchema>;
