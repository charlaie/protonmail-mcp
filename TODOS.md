# Remaining capabilities and guarantees

This tracks gaps after the draft/send reliability work. Automated checks passed, but live Proton Bridge and MCP client validation remains outstanding. A documented provider API capability does not establish that an Outlook or Gmail app exposes it in every client or workspace.

## Current priorities

- [x] Support outgoing attachments and PNG/JPEG/GIF inline images in composition, drafts, editing, and sending. Plain text remains the default. Inline images use escaped generated HTML with a text alternative. Live rendering checks remain outstanding.
- [x] Support read state, stars, archive, Trash, moves, and existing labels where Bridge advertises the required capabilities. Inbox writes require separate local action/source/destination grants, preserve sender restrictions, and share durable draft/send claims. Live synchronization checks remain outstanding.
- [x] Support forwarding with explicit send approval, content binding, durable operation IDs, and send recovery. Original attachments require explicit selection through authorized download tools; forwarding never automatically reads or copies them.

## Other capability gaps

- [ ] General HTML composition and editing arbitrary rich drafts, if a concrete use case justifies them.
- [x] Support creating folders and labels. `create_mailbox` uses explicit tool and creation-kind grants, supports nested folders, and checks existing paths before creation. New mailboxes require separate read and message-write grants. Live Bridge synchronization checks remain outstanding.
- [ ] Support archive, Trash, move, and label actions starting from All Mail and Starred. Resolve the message to its actual source folder and recheck identity and source/destination permissions before writing. Refuse ambiguous matches and preserve unrelated labels and stars. These placement actions currently require the source folder; read/star changes already work through views.
- [ ] Search pagination, unread/flag filters, batch reads, and reliable traversal beyond the current 100-result limit per mailbox.
- [x] Use Bridge metadata for better message identity and thread reconstruction. Optional `X-Pm-Internal-Id` and `X-Pm-External-Id` aliases connect synthetic reply references and deduplicate mailbox appearances. Standard Message-ID, References, and In-Reply-To traversal remains the fallback. Mailbox and sender restrictions apply to both paths; this remains best-effort reconstruction, not Proton's native conversation grouping. Live Bridge header checks remain outstanding.
- [x] Add a stable logical draft identifier across edits. Draft reads and operation records expose an account-local `draftId`; read/edit/send tools accept it and resolve the latest confirmed replacement through the shared journal. Existing physical identities remain supported. Uncertain APPEND blocks resolution, and revision, UIDVALIDITY, policy and send protections still apply. Live Bridge checks remain outstanding.
- [x] Allow choosing a configured sender alias for new emails, forwards, drafts, and reply drafts. Tool schemas advertise the configured `from` choices; send approval and operation hashes bind the selected sender. Edits preserve the saved sender. Live Bridge alias validation remains outstanding.
- [ ] Add explicit Reply-To composition after validating Bridge preservation for Proton and external recipients. Investigate importance and sensitivity separately according to Bridge support.
- [x] Remove the fixed incoming attachment extension registry. Raw downloads support arbitrary extensions and extensionless files under an explicit wildcard or specific suffix grants, preserve declared MIME types, and use a uniform 5 MiB decoded limit. Existing policies keep their restrictions.
- [ ] Improve client attachment delivery and previews. The receiving client still handles parsing, rendering, and OCR; named inline text parts that the downloader may transform remain refused.
- [x] Add file-based account configuration, Clack setup, per-tool grants, client configuration generators, and doctor. Each account uses a separate config and policy; processes for the same account share a journal.
- [ ] Consider managed sign-in, remote deployment, centralized action permissions, and shared-account roles if this becomes a hosted or team product.
- [ ] Consider an integrated composition and recovery interface with message links, attachment previews, and clear operation outcomes.

## Guarantees to improve or validate

- [ ] Complete the [live Bridge and client release checklist](docs/draft-send-release-checklist.md), including Proton web/mobile synchronization and full approval presentation in every supported client.
- [ ] Add an independent outbound policy: recipient/domain allowlists, external-recipient restrictions, recipient-count limits, and local sending quotas. Read-policy sender restrictions do not restrict outgoing destinations.
- [ ] Validate that approval clients show every recipient and the complete body. The server verifies a single-use, content-bound approval response, but cannot prove what a person actually saw or whether a client supplied approval automatically.
- [ ] Add an audit system if required: approver identity, tamper-evident records, and a defined retention policy. The SQLite journal currently stores recovery metadata and hashes, not complete approved message contents or human identity.
- [ ] Add journal backup/restore guidance or tooling, health monitoring, and a safe storage-growth plan. Do not prune claims in a way that re-enables attempted operations.
- [ ] Investigate safe resolution of operations that remain uncertain without a matching saved message. Do not treat no search match as proof that an external write failed.

## Limits that remain part of the contract

- Message removal uses Trash. Permanent deletion is out of scope; Trash retention follows the account's Proton Mail settings.
- The server allows at most one SMTP attempt per operation ID against an intact journal shared by all processes for the account. This is not an exactly-once delivery guarantee.
- SMTP acceptance means Bridge accepted submission. It does not prove delivery to every recipient. Sent-copy evidence also does not establish per-recipient delivery.
- Replacing operation IDs, deleting the journal, restoring an old backup, or manually copying messages can defeat identity-based replay protection.
- External Proton clients do not participate in the journal's claims. Revision checks detect observed changes, but another client can still act between a final check and a server write.
- IMAP draft replacement uses separate append and delete operations. Partial outcomes can leave two copies that require reconciliation or cleanup.
- Recovery favors safety over eventual completion. A crash after reserving APPEND but before performing it can leave an unresolved operation with no matching draft. APPEND errors are conservatively uncertain because the library can fail after acceptance.
- A crash can leave an inbox write marked `reserved` or `submitting` with an active reservation. It cannot be automatically reconciled while its writer might still run. Manual inspection requires stopping every process for the account. Confirmed pre-dispatch failures end `aborted` and release claims; missing evidence after dispatch never proves a failed write.
- Removing a Proton label through Bridge also selects an ordinary destination folder and may relocate the message. Labels must use explicit label actions; IMAP keywords are not synchronized Proton labels.
- Sender allowlisting checks message headers and does not authenticate the sender. Message text and attachment data can contain prompt injection and must not authorize tool actions.
- Bridge must be running and signed in. The server does not establish a hosted availability guarantee or independently verify provider delivery.

## Comparison references

- [Office 365 Outlook connector](https://learn.microsoft.com/en-us/connectors/office365/) documents HTML, attachments, forwarding, mailbox actions, sender controls, and shared-mailbox actions. It also warns that automatic retries after a timeout can duplicate sends.
- [OpenAI's inbox workflow](https://learn.chatgpt.com/use-cases/manage-your-inbox) documents Gmail reply drafts, archive, labels, and Trash. Available actions depend on the plugin and workspace settings; do not assume the app exposes all Gmail API capabilities.
- [Gmail draft API](https://developers.google.com/workspace/gmail/api/guides/drafts) documents a stable draft container ID even when its underlying message changes.
- [OpenAI plugin controls](https://learn.chatgpt.com/docs/enterprise/apps-and-connectors) document managed role, action, and service-authorization controls.
