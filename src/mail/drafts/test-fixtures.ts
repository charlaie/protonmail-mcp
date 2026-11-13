import type { MailWriteAuthorization } from "@/bridge/authorization.js";
import { allowAllMessages } from "@/bridge/imap/reading/messages.js";
import { EditDraftRequestSchema } from "./requests.js";

/** Write authorization for tests that exercise drafts without a read policy. */
export const allowAllWrites: MailWriteAuthorization = async () => {};

export const permissiveDraftChecks = {
	accepts: allowAllMessages,
	authorize: allowAllWrites,
};

/** Parses an edit by physical identity; edit_draft identities omit the mailbox. */
export function physicalEdit(input: Record<string, unknown>) {
	const { mailbox: _mailbox, ...request } = input;
	return EditDraftRequestSchema.parse(request);
}
