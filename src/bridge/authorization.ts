import type { MessageSummary } from "@/mail/message.js";

// Called after asynchronous preflight and journal claims, immediately before
// dispatching a mail mutation. No Bridge I/O may intervene after authorization.
export type MailWriteAuthorization = (
	mailbox: string,
	messages?: MessageSummary[],
) => Promise<void>;
