import type { MailWriteAuthorization } from "@/bridge/authorization.js";
import { allowAllMessages } from "@/bridge/imap/reading/messages.js";

/** Write authorization for tests that exercise drafts without a read policy. */
export const allowAllWrites: MailWriteAuthorization = async () => {};

export const permissiveDraftChecks = {
	accepts: allowAllMessages,
	authorize: allowAllWrites,
};
