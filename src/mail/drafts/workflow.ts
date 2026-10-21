import type { z } from "zod";
import type { BridgeConfig } from "../../bridge/config.js";
import type { MailAccess } from "../access.js";
import { composeReplyDraft } from "./composition/replies.js";
import type { CreateDraftInput, CreateReplyDraftSchema } from "./requests.js";
import type { createDraftService } from "./service.js";

export function createDraftWorkflow(input: {
	config: BridgeConfig;
	drafts: Pick<ReturnType<typeof createDraftService>, "create" | "existing">;
	mailAccess: () => Promise<MailAccess>;
}) {
	const { config, drafts, mailAccess } = input;

	async function create(request: CreateDraftInput) {
		const mail = await mailAccess();
		const mailbox = await mail.requireDraftsMailbox();
		return drafts.create(
			{ ...request, mailbox },
			{ authorize: mail.authorizeMailWrite("create_draft") },
		);
	}

	async function reply(request: z.infer<typeof CreateReplyDraftSchema>) {
		const mail = await mailAccess();
		const mailbox = await mail.requireDraftsMailbox();
		// Replays must not depend on the original message still being present.
		const previous = await drafts.existing(request.operationId, request);
		if (previous) return previous;

		const original = await mail.getMessage(request);
		return drafts.create(
			composeReplyDraft(config, original, request, mailbox),
			{
				request,
				authorize: mail.authorizeMailWrite("create_reply_draft", [
					{ mailbox: request.mailbox, message: original },
				]),
			},
		);
	}

	return { create, reply };
}

export type DraftWorkflow = ReturnType<typeof createDraftWorkflow>;
