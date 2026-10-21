import type { SubmissionChecks } from "./service.js";

/** Submission checks for tests that exercise sending without policy or draft cleanup. */
export const permissiveChecks: SubmissionChecks = {
	authorize: async () => {},
	cleanupDraft: async () => ({ status: "not_applicable" }),
};
