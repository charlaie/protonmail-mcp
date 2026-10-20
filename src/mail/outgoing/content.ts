import { z } from "zod";

export const EmailAddressSchema = z.email().describe("A single email address.");
export const EmailListSchema = z
	.union([EmailAddressSchema, z.array(EmailAddressSchema).min(1)])
	.transform((value) => (Array.isArray(value) ? value : [value]))
	.describe("One email address or a non-empty array of email addresses.");

export const SubjectSchema = z
	.string()
	.max(998)
	.regex(/^[^\r\n]*$/, "Subject must be a single line.");
export const TextSchema = z
	.string()
	.max(100_000, "Email body must be at most 100,000 characters.");
