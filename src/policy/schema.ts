import { z } from "zod";

const DomainSchema = z
	.string()
	.min(1)
	.regex(
		/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i,
		"Expected a domain like example.com.",
	)
	.transform((value) => value.toLowerCase());

export const ReadPolicySchema = z.object({
	version: z.literal(1),
	allowedMailboxes: z.array(z.string().min(1)).min(1),
	allowedSenderEmails: z.array(z.email().transform((value) => value.toLowerCase())),
	allowedSenderDomains: z.array(DomainSchema),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
});

export type ReadPolicy = z.infer<typeof ReadPolicySchema>;

export function createReadPolicy(input: {
	allowedMailboxes: string[];
	allowedSenderEmails?: string[];
	allowedSenderDomains?: string[];
}): ReadPolicy {
	const now = new Date().toISOString();

	return ReadPolicySchema.parse({
		version: 1,
		allowedMailboxes: [...new Set(input.allowedMailboxes.map((value) => value.trim()))],
		allowedSenderEmails: [
			...new Set(
				(input.allowedSenderEmails ?? []).map((value) =>
					value.trim().toLowerCase(),
				),
			),
		],
		allowedSenderDomains: [
			...new Set(
				(input.allowedSenderDomains ?? []).map((value) =>
					value.trim().toLowerCase(),
				),
			),
		],
		createdAt: now,
		updatedAt: now,
	});
}
