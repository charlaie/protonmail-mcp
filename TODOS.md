# Remaining capabilities and guarantees

This tracks gaps after the draft/send reliability work. Automated checks passed, but live Proton Bridge and MCP client validation remains outstanding. A documented provider API capability does not establish that an Outlook or Gmail app exposes it in every client or workspace.

## Current priorities

- [ ] Support outgoing attachments and inline images in composition, drafts, editing, and sending. Keep plain text as the default. Inline images may use generated HTML with a text alternative; general HTML authoring is not a priority.
- [ ] Support inbox actions that Proton Bridge actually exposes, including read state, stars, archive, Trash, moves, and labels where supported. Add explicit local write permissions, validate source and destination access, and preserve sender restrictions and durable draft/send claims.
- [ ] Support forwarding with explicit approval before submission, using the same content binding, durable operation IDs, and recovery guarantees as sending. Do not bypass source-read or attachment permissions.

## Other capability gaps

- [ ] General HTML composition and editing arbitrary rich drafts, if a concrete use case justifies them.
- [ ] Search pagination, unread/flag filters, batch reads, and reliable traversal beyond the current 100-result limit per mailbox.
- [ ] Improve thread reconstruction where Bridge provides useful metadata. Current threading is a best-effort reconstruction from Message-ID, References, and In-Reply-To.
- [ ] Add a stable logical draft identifier across edits. IMAP replacement currently creates a new UID, so clients must use the returned replacement identity.
- [ ] Allow choosing a configured sender alias for new compositions and setting Reply-To. Consider importance and sensitivity separately according to Bridge support.
- [ ] Improve incoming attachment format coverage and client delivery. Current download formats are text, CSV, TSV, Markdown, JSON, and PDF, with 1 MiB text and 5 MiB PDF limits. The receiving client handles parsing, rendering, and OCR.
- [ ] Add easier account switching and configuration. Each account currently requires its own Bridge credentials, policy, and shared local journal.
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

- The server allows at most one SMTP attempt per operation ID against an intact journal shared by all processes for the account. This is not an exactly-once delivery guarantee.
- SMTP acceptance means Bridge accepted submission. It does not prove delivery to every recipient. Sent-copy evidence also does not establish per-recipient delivery.
- Replacing operation IDs, deleting the journal, restoring an old backup, or manually copying messages can defeat identity-based replay protection.
- External Proton clients do not participate in the journal's claims. Revision checks detect observed changes, but another client can still act between a final check and a server write.
- IMAP draft replacement uses separate append and delete operations. Partial outcomes can leave two copies that require reconciliation or cleanup.
- Recovery favors safety over eventual completion. A crash after reserving APPEND but before performing it can leave an unresolved operation with no matching draft. APPEND errors are conservatively uncertain because the library can fail after acceptance.
- Sender allowlisting checks message headers and does not authenticate the sender. Message text and attachment data can contain prompt injection and must not authorize tool actions.
- Bridge must be running and signed in. The server does not establish a hosted availability guarantee or independently verify provider delivery.

## Comparison references

- [Office 365 Outlook connector](https://learn.microsoft.com/en-us/connectors/office365/) documents HTML, attachments, forwarding, mailbox actions, sender controls, and shared-mailbox actions. It also warns that automatic retries after a timeout can duplicate sends.
- [OpenAI's inbox workflow](https://learn.chatgpt.com/use-cases/manage-your-inbox) documents Gmail reply drafts, archive, labels, and Trash. Available actions depend on the plugin and workspace settings; do not assume the app exposes all Gmail API capabilities.
- [Gmail draft API](https://developers.google.com/workspace/gmail/api/guides/drafts) documents a stable draft container ID even when its underlying message changes.
- [OpenAI plugin controls](https://learn.chatgpt.com/docs/enterprise/apps-and-connectors) document managed role, action, and service-authorization controls.
