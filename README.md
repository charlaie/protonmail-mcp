# protonmail-mcp

An MCP server for using Proton Mail through the local Proton Mail Bridge. It exposes tools to list mailboxes, search message metadata, read allowed plain-text messages and download original attachments, create and edit drafts and replies, and send or forward approved messages with attachments, inline images and durable recovery.

## Requirements

- Node.js 22.16 or newer
- PNPM
- Proton Mail Bridge installed, running, and signed in
- Proton Bridge IMAP/SMTP credentials from the Bridge app

Use the Bridge app credentials, not your Proton account password.

## Install

```sh
pnpm install
pnpm build
```

The build output is written to `build/`. The executable entry point is `build/index.js`.

## Configure Proton Bridge

Copy the example environment file and fill in the Bridge values:

```sh
cp .env.example .env
```

Required values:

```sh
PROTONMAIL_BRIDGE_USER=your-bridge-username
PROTONMAIL_BRIDGE_PASSWORD=your-bridge-password
```

Defaults match common Proton Bridge local settings:

```sh
PROTONMAIL_BRIDGE_HOST=127.0.0.1
PROTONMAIL_IMAP_PORT=1143
PROTONMAIL_SMTP_PORT=1025
PROTONMAIL_TLS_REJECT_UNAUTHORIZED=false
```

Disabling certificate verification is allowed only for literal loopback IPs or `localhost`. The server pins `localhost` to `127.0.0.1`. Other hosts require `PROTONMAIL_TLS_REJECT_UNAUTHORIZED=true` and a valid, trusted certificate; STARTTLS remains mandatory for both IMAP and SMTP. A self-signed remote certificate must be trusted explicitly, for example through Node's `NODE_EXTRA_CA_CERTS`.

Optionally set `PROTONMAIL_BRIDGE_OWN_ADDRESSES` to a comma-separated list of this account's aliases. The Bridge username is included automatically. Reply-all excludes these addresses, replies select the addressed alias when configured, and draft sending accepts only configured account senders. This is local configuration, not a tool-controlled sender allowlist.

Optionally set `PROTONMAIL_MCP_POLICY_FILE` to choose where the read policy is stored. By default it uses `~/.config/protonmail-mcp/read-policy.json`.
An empty value uses that default. For multiple Bridge accounts, give each MCP configuration its own policy file.

## Set Up Read Policy

Before the MCP can search or read messages, configure the local read allowlist:

```sh
pnpm setup
```

The setup command lists Bridge mailboxes and asks which mailboxes the model may search and read. You can also restrict reads by sender email or sender domain.
Only selectable mailboxes appear. Invalid selections or sender entries prompt you to try again.

A sender matches the policy when its email appears in the email list or its exact domain appears in the domain list. Leave both lists empty to allow every sender in the selected mailboxes.

Setup also asks which attachment extensions may be downloaded. Supported values are `.txt`, `.csv`, `.tsv`, `.md`, `.json`, and `.pdf`. Enter the extensions with their leading dots, separated by commas. Blank disables attachment content reads. Existing version 2 policies that omit `allowedAttachmentExtensions` also disable attachment reads; run `pnpm setup` to enable them. Attachment metadata remains available for allowed messages. The model cannot change this allowlist through tool arguments.

Setup asks whether each attachment download requires human approval. This sets `requireAttachmentApproval` in the version 2 policy. The setting defaults to `false`, including for existing policies that omit it. Set it to `true` through setup to require approval before the server downloads attachment contents. The model cannot change this setting through tool arguments. Listing attachment metadata does not require this approval.

Setup separately asks which inbox actions and mailboxes may be changed. Blank disables inbox writes. Existing policies also default to disabled. Enabled `inboxWrites` grants list actions and exact source/destination mailbox paths, all of which must already be readable. Sender restrictions still apply. These local grants authorize inbox actions without a per-action approval prompt; sending and forwarding always require their separate approval. The model cannot widen these grants.

Policies are bound to the Bridge username used during setup. Existing version 1 policies and policies for another account cannot authorize reads or draft access. Run `pnpm setup` to create a version 2 policy for the current account. Setup replaces the policy file atomically.

Draft tools also require the Drafts mailbox to be selected during setup. If Drafts is not allowed, draft tools return a policy error explaining how to enable access.
Sender restrictions govern draft reads, patch edits, reconciliation, and cleanup. Creating a new draft requires Drafts mailbox access. Reading a reply source requires its sender permission. Journal get/list tools expose only local operation metadata and remain available during policy outages.

Useful policy commands:

```sh
pnpm policy
pnpm reset-policy
pnpm policy:check
pnpm test
```

`reset-policy` can remove a malformed policy file. Setup and reset require an interactive terminal.

## Configure an MCP Client

Build the project first, then point your MCP client at `build/index.js`.

Example JSON:

```json
{
  "mcpServers": {
    "protonmail": {
      "command": "node",
      "args": ["/Path/To/Repo/protonmail-mcp/build/index.js"],
      "env": {
        "PROTONMAIL_BRIDGE_USER": "your-bridge-username",
        "PROTONMAIL_BRIDGE_PASSWORD": "your-bridge-password",
        "PROTONMAIL_BRIDGE_HOST": "127.0.0.1",
        "PROTONMAIL_IMAP_PORT": "1143",
        "PROTONMAIL_SMTP_PORT": "1025",
        "PROTONMAIL_TLS_REJECT_UNAUTHORIZED": "false"
      }
    }
  }
}
```

If your MCP client starts servers from the repository directory, you can also use a `.env` file. For clients that start from another working directory, pass environment variables explicitly as shown above.

## Available MCP Tools

- `list_mailboxes`: returns a `mailboxes` array containing Proton Bridge IMAP mailboxes and whether each is allowed by the read policy.
- `search_messages`: returns the newest allowed summaries by received date. Sender filtering happens before the result limit. Each summary includes `uid` and `uidValidity`.
- `get_message`: reads one allowed message by mailbox, UID, and UIDVALIDITY. HTML-only messages are converted to plain text. Attachment contents are omitted. Messages larger than 10 MiB must be read in Proton Mail.
- `list_attachments`: lists filename, MIME type, transfer-encoded size, attachment ID, and download eligibility for an allowed message. Fetches MIME structure without downloading attachment contents. Eligibility describes policy and metadata checks; downloading also validates actual part headers and decoded size.
- `get_attachment`: downloads one attachment ID returned by `list_attachments`, using the same mailbox, UID, and UIDVALIDITY. Downloads only that part, even if the whole message exceeds the message-read limit. Always returns original bytes as an MCP embedded binary resource, with untrusted metadata and client compatibility guidance. The `format` argument has been removed. Text-format attachments are limited to 1 MiB and PDFs to 5 MiB. The local policy can require human approval before each download. The receiving client handles text decoding, document parsing, rendering, and OCR.
- `get_thread`: reconstructs a reply chain across allowed mailboxes using exact Message-ID, References, and In-Reply-To tokens. This is a best-effort reconstruction. `limitReached` reports when the result cap is reached. `includeText: false` returns summaries; otherwise `bodyStatus` explains whether each body is included or unavailable. Total returned thread text is limited to 500,000 characters. Use `get_message` for bodies omitted by that limit.
- `get_inbox_capabilities`: reports native MOVE support, the current inbox write policy, and readable mailbox kinds and write grants. Individual flag operations also require the selected mailbox to advertise permanent flag support.
- `manage_message`: changes one allowed message using a durable `operationId`, mailbox, UID, UIDVALIDITY and `change`. Actions are `mark_read`, `mark_unread`, `star`, `unstar`, `archive`, `trash`, `move`, `apply_label`, and `remove_label`. Moves require native IMAP MOVE; copy/delete fallback is refused. No action permanently deletes mail or mutates Drafts.
- `get_inbox_operation` and `list_inbox_operations`: inspect local operation metadata or paginate unresolved operations without reading bodies. Repeating a recorded request returns its outcome without another write.
- `reconcile_inbox_operation`: checks positive flag or placement evidence for an uncertain operation without writing mail. Missing, ambiguous or changed evidence keeps uncertainty. An operation still marked `submitting` cannot be reconciled because its writer may still be running.
- `create_draft`: saves a plain-text draft, including an empty composition. Requires an `operationId` UUID. Identical retries return the durable operation without another APPEND. Successful identity and revision are in `outcome`. It never sends mail.
- `create_reply_draft`: creates a reply or reply-all draft from an allowed mailbox, UID, and UIDVALIDITY. It respects Reply-To, excludes configured own addresses, deduplicates recipients, never copies original Bcc recipients, and derives In-Reply-To and References. `replyAll` defaults to false; `text` may be empty. Requires an `operationId` UUID reused on retries, source read permission and Drafts access. It never sends mail.
- `get_draft`: reads an allowed draft, including unfinished zero-recipient drafts, Bcc and byte-free attachment/inline-image manifests, and returns a `revision` token for editing. Supports plain text, files and the generated inline-image body. Arbitrary HTML is refused.
- `edit_draft`: patches a readable plain-text draft using UID, UIDVALIDITY, `expectedRevision` from `get_draft`, and a new `operationId` UUID. Omitted fields are retained. Empty recipient arrays clear those recipients; empty strings clear subject or body. Preserves sender alias, Reply-To and reply headers. Creates one replacement with a unique Message-ID, then deletes the unchanged original using UIDPLUS. A stale revision is rejected before APPEND. Identical retries return the saved operation.
- `get_draft_operation` and `list_draft_operations`: inspect durable draft operation metadata or list unresolved operations without fetching message bodies. Lists accept `limit` and `offset`; `nextOffset: null` ends pagination. The unresolved set can change between pages.
- `reconcile_draft_operation`: searches allowed Drafts for exactly one operation Message-ID with matching canonical content. Harmless transport headers may differ; recipients, sender, subject, body and reply headers must match. No match keeps uncertainty, and conflicting or duplicate copies are refused. Never appends or deletes mail.
- `retry_draft_cleanup`: deletes only an edit operation's recorded original after verifying both original and replacement revisions, current policy, UIDVALIDITY and UIDPLUS. Never appends or sends. Reconcile uncertain APPEND first.

- `send_email`: sends text with optional attachments and inline images after mandatory user approval of the sender, recipients, subject, reply metadata, complete body and file/image manifests. Bodies are limited to 100,000 characters. Requires a new `operationId` UUID for each intended send; repeat the same ID and arguments to retrieve an attempted operation's outcome without submitting it again.
- `send_draft`: sends a supported Drafts snapshot identified by UID and UIDVALIDITY after full-message approval. Requires an `operationId` UUID and account, mailbox, and sender read permission. It preserves recipients, Bcc, sender, subject, text, Reply-To, threading headers, files and supported inline images. Arbitrary HTML, unsupported media, invalid headers, unconfigured sender aliases, and oversized drafts are refused. Changing the snapshot requires a new operation and approval. After full SMTP acceptance, it checks the snapshot again before deleting only that draft with UIDPLUS. Deletion is a separately reported outcome; a deletion failure never triggers another send.
- `forward_email`: quotes the allowed source's headers and plain text, adds an optional introduction, and sends after the same full-message approval and durable journal checks as other sends. Requires `operationId`, `source: { mailbox, uid, uidValidity }`, and new recipients. Original Bcc and attachments are omitted; supplied outgoing attachments/images are explicitly approved. The source is reauthorized and its quoted fields are checked after approval. It never deletes or changes the source.
- `get_send_operation`: retrieves the current account's durable operation record by `operationId`, including after a restart. It never sends mail. Interrupted submissions are reported as uncertain.
- `list_send_operations`: lists prepared, uncertain, partial, and accepted operations needing draft cleanup. Uses the same `limit`, `offset`, and `nextOffset` pagination contract as draft operations.
- `retry_send_cleanup`: retries only deletion of the recorded unchanged draft for a fully accepted send under current read policy and UIDPLUS. Never submits SMTP. Partial and uncertain sends are refused.
- `reconcile_send_operation`: searches the policy-allowed Sent mailbox for an uncertain operation's exact preassigned Message-ID. Positive evidence records matching identities in `sentCopies`, separately from the SMTP outcome. No match leaves the operation uncertain. It never resends or deletes drafts.

`get_message`, `get_thread`, `list_attachments`, `get_attachment`, `create_reply_draft`, `send_draft`, and `edit_draft` require the `uidValidity` returned with the message identity. A mailbox reset invalidates old identities; search again before retrying. Tool failures set `isError: true`, including policy refusals and partial draft or email outcomes. Tools advertise output schemas and return `structuredContent` alongside JSON text for older clients. Ordinary errors have `{ status: "error", error: { code, message, retry } }`. Retry guidance distinguishes safe retry, refreshed identity, configuration changes, renewed approval, reconciliation, and no retry.

### Inbox management

For example, archive a message with `manage_message`:

```json
{
  "operationId": "5cf0dd38-1353-45fa-bdb7-3cfbf9d81d9f",
  "mailbox": "INBOX",
  "uid": 42,
  "uidValidity": "7",
  "change": { "action": "archive" }
}
```

Source and destination require read and inbox write grants. Flags preserve unrelated flags. Archive and Trash use Bridge's corresponding folders; `move` requires an exact ordinary-folder destination. All Mail and Starred are views, so placement changes must use the message's ordinary folder. Read/star flags can be changed through views, including unstar through Starred.

Proton exposes existing labels as `Labels/…` mailboxes. `apply_label` uses a native move from an ordinary folder into a label projection; Proton retains the message's ordinary folder. `remove_label` moves from the label projection to an explicit ordinary folder, removing that label and choosing the message's destination folder. This can relocate the message. Generic moves cannot implicitly change labels. Label creation and arbitrary IMAP keyword tags are unsupported. See [Proton's label behavior](https://proton.me/support/labels-in-bridge).

The journal reserves each active message identity and Message-ID across inbox, draft and send writes. Uncertain writes retain their reservation and never run again automatically. Reconciliation requires positive evidence under current policy. A crash can leave an inbox operation marked `submitting`; it stays reserved because the server cannot prove its writer has stopped. Inspect it manually with all account processes stopped. External Proton clients do not share these claims, and IMAP does not provide a transaction spanning a final metadata check and a write.

### Send recovery

For example, use a new UUID when asking to send a draft:

```json
{
  "operationId": "695c6c8e-c22a-46ed-8f12-04e7df0a1b4b",
  "uid": 123,
  "uidValidity": "7"
}
```

Retain that ID across approval rounds, retries, and server restarts. A UUID is permanently bound to its original request and approved-content hash. The server commits a submission claim before SMTP starts. Only one SMTP attempt is allowed per ID across processes sharing the journal. A draft identity also cannot be submitted under competing IDs while an earlier attempt is accepted, partial, or uncertain. A definite rejection allows a newly approved attempt under a new ID.

The result contains `operationId`, the preassigned `messageId`, timestamps, hashes, source identity, `outcome`, `draftCleanup`, `sentCopies`, and `retry`. Outcomes include `prepared`, `accepted`, `partially_accepted`, `rejected`, and `uncertain`. Accepted means Bridge accepted submission, not that every recipient received it. A partial outcome lists accepted and rejected recipients; never resend to accepted recipients. Partial and uncertain sends retain their draft. Sent-copy evidence never replaces a known SMTP outcome and does not establish which recipients received the message. An uncertain operation with positive Sent evidence still has an unknown SMTP result and advises against retrying.

The SQLite journal defaults to `send-operations/` beside the policy file. Set `PROTONMAIL_MCP_OPERATIONS_DIR` to choose another local directory. Each account has a separate database with private file permissions. Records contain request/content hashes, optional file/image manifests and outcome metadata, not message bodies, attachment bytes or Bridge passwords. Keep the journal when moving configurations or recovering a server; deleting it removes replay protection. Use a local filesystem and share this directory among MCP processes for the same account. SQLite commits use synchronous FULL durability; interrupted or unrecorded SMTP outcomes stay uncertain and block automatic retries.

A Message-ID correlates a submission with Sent; it does not guarantee SMTP deduplication or exactly-once delivery. A Sent copy does not prove delivery to every recipient. Do not create a replacement operation ID merely because an acknowledgment was lost. Resolve uncertainty using the recorded ID and Sent evidence first.

Draft edit and send claims share one account SQLite transaction. An attempted send blocks editing its draft while submitting, uncertain, partially accepted, or accepted, including when deletion failed. A definite rejection permits a new approved operation. An edit permanently retires its original identity, and an unresolved replacement cannot be sent or edited. These claims survive restarts and coordinate processes sharing the journal.

### Draft recovery and contract migration

All draft mutations now require `operationId`. Create/reply/edit responses use a durable record with `outcome`, replacing the previous top-level `created`/`updated` response fields. `outcome.status` is `appending`, `saved`, `cleanup_failed`, or `completed`. Successful identity and raw MIME revision are in `outcome.identity` and `outcome.revision`. `appending` means an APPEND attempt was reserved and may still be in progress or have an uncertain outcome. It is not permission to retry under a different ID. A crash after the claim but before APPEND may leave uncertainty without a matching draft; recovery deliberately does not guess that it is safe to append again. APPEND errors are conservatively uncertain, including some explicit failures: the IMAP library can fail during a command after the server accepted APPEND. Operations with no matching copy may require manual inspection rather than automatic recovery.

Read the draft with `get_draft`, then call `edit_draft` with its revision. Clients that previously supplied a full replacement must add the UUID and revision. Omitted fields now preserve content. Use `[]` or `""` to clear explicitly. Creating/replaying a reply binds the original user request, so an existing operation can be inspected even if the reply source later disappears.

Use `list_draft_operations` to find unresolved writes after a restart. Reconcile `appending` operations without writing to the mailbox. A recovered create becomes `completed`; a recovered edit becomes `saved`, and `retry_draft_cleanup` completes deletion separately. Cleanup leaves the original when the replacement is missing or either content revision changed. An existing UID with unavailable source content remains unresolved. A confirmed absent original, after checking UIDVALIDITY, counts as completed deletion. Completed cleanup cannot regress when an older request finishes late.

Keep the operation database when upgrading; the existing send journal is extended with draft records and claims. Draft mutations made before this upgrade have no durable history and require manual inspection. External mail clients do not participate in journal claims. Their changes detected during approval or cleanup are refused or retained, but they can still act between the final check and a server write. Manually copying messages or restoring an old journal can defeat identity-based replay protection. There is no automatic retention or pruning of journal claims.

## Outgoing attachments and inline images

`send_email`, `create_draft`, `create_reply_draft`, `edit_draft`, and `forward_email` accept `attachments` and `inlineImages`. Each file has a safe `filename`, a lowercase `contentType` without parameters, and `contentBase64` containing its original bytes in canonical base64. An optional `charset` preserves the MIME character set of a text file. Files may be empty. Paths, URLs, data URIs, raw MIME and custom headers are not accepted. The server never retrieves outgoing file contents from the network or filesystem.

For example, attach the exact three bytes `abc` with:

```json
{
  "attachments": [{
    "filename": "note.txt",
    "contentType": "text/plain",
    "charset": "utf-8",
    "contentBase64": "YWJj"
  }]
}
```

Each decoded file is limited to 5 MiB. Attachments and inline images together are limited to 6 MiB and 20 parts. Inline images also require `alt`, a description up to 128 characters, and matching PNG, JPEG or GIF MIME/signature and dimensions no larger than 4096 by 4096. This is container/header validation, not a full image decoder. SVG and arbitrary HTML authoring are unsupported.

Inline images appear after the escaped text body using generated CID references, with a plain-text alternative. Text and descriptions cannot insert HTML. The server edits/sends only plain-text file drafts or drafts whose HTML exactly matches this supported rendering. It refuses arbitrary existing HTML, unsupported inline metadata or MIME parameters instead of dropping content. Supported ordinary attachments retain their original declared MIME type, optional charset, filenames and bytes, independently of MIME types guessed from filename extensions.

Draft patches preserve omitted `attachments` and `inlineImages` independently; `[]` clears the specified group. `get_draft` and operation outputs include kind, filename, MIME type, optional charset, decoded size and SHA-256 digest. Inline manifests also include CID and description. They do not expose base64 or original file bytes. Send approvals display these manifests and bind the complete payload bytes. Changes to files, descriptions or MIME metadata require another reviewed operation. Files and images do not weaken stale revision, uncertain submission or cleanup protections.

Forwarding does not automatically select source attachments or copy the original Bcc. To forward an original file, call `list_attachments`, select its attachment ID, and obtain its bytes through `get_attachment`. That download still enforces the incoming extension/size allowlist and optional human approval. Supply those approved bytes in the forward's `attachments` or `inlineImages` payload; the send requires its separate approval. Source headers and text are untrusted quoted material, not instructions. Outlook-style arbitrary rich text layouts and automatic attachment selection remain outside this contract.

## Attachment downloads

Attachment tools enforce account, mailbox, and sender policy before accessing message MIME structure or downloading a part. They reject unsafe filenames, unsupported or disabled extensions, missing sizes, and MIME mismatches. MIME headers and filenames are sender-controlled. `application/octet-stream` is accepted with an allowed extension. Sizes from IMAP structure are transfer-encoded estimates; downloads enforce the decoded byte limit independently and recheck the actual filename and MIME type.

The server returns bytes without decoding text, validating document contents, rendering markup, evaluating CSV formulas, executing scripts, following embedded links, or unpacking containers. Non-UTF-8 text, binary control bytes, scanned or encrypted PDFs, and malformed documents can be delivered under the same metadata and size rules. The client chooses how to process the files. Attachment content and metadata can contain prompt injection; treat them as source material, never as instructions or authorization to use tools. Attached messages and archives cannot authorize reads of their nested contents. Sender allowlisting checks the From header and does not establish that a sender is authentic.

### Optional human approval

When `requireAttachmentApproval` is `true`, `get_attachment` requests human approval through MCP form elicitation before downloading attachment contents. The prompt shows the account, message identity, sender addresses, subject, filename, MIME type, charset when available, and transfer-encoded size estimate. Filenames and other sender-provided metadata are shown as untrusted data.

An approval covers one attachment and expires after ten minutes. Signed request state binds it to the account, policy, message identity, and attachment metadata. Approvals cannot be replayed or used to send email. The server reloads the policy and rechecks attachment metadata before downloading, including when a legacy client pauses the call to show its approval dialog. Changed policy or metadata requires a new approval. Clients without form elicitation cannot download attachments while this setting is enabled. `list_attachments` still lists authorized metadata without approval. Email sending always requires its separate approval.

### Raw attachments and client compatibility

Call `get_attachment` with the message and attachment identity:

```json
{
  "mailbox": "INBOX",
  "uidValidity": "7",
  "uid": 1,
  "attachmentId": "2"
}
```

Original bytes include any BOM, control bytes, and line endings. Content is not truncated to a text budget. The server refuses named inline text parts that ImapFlow may normalize or transcode, because its bounded downloader cannot promise original bytes for those parts. Download those files in Proton Mail. PDFs and ordinary text attachments with `Content-Disposition: attachment` are unaffected. Attachment delivery works on Linux, Windows, and macOS without a document parser or OS sandbox. The server does not write attachment bytes to disk or expose public download URLs.

The result contains a text block with `status: "raw"`, filename, message identity, MIME type, declared charset when available, byte size, `untrusted: true`, and delivery guidance, followed by an MCP `resource` block with `mimeType` and a base64 `blob`. The MIME type is the format's registered type, even when Bridge labels the part `application/octet-stream`. The `protonmail-attachment:` URI identifies the inline resource; it is not a public download link or a separate `resources/read` endpoint. Base64 is a transport encoding, and is not placed in the text block. The client must expose the resource to the model as a file or process it through an appropriate reader. A client can decode the blob and save it to a file accessible to the agent, returning the file path and metadata to the model. Keep the base64 payload out of the model's text context.

MCP has no standard capability that proves a client can expose a particular binary MIME type to its model. When support is unknown, the tool returns the resource with `clientSupport: "unverified"` and guidance to use a compatible client or download the file in Proton Mail. The server cannot detect a client silently dropping a resource or a client-side/model-side rejection after the result has been delivered.

Clients can optionally declare MIME types they support using this server-specific capability:

```json
{
  "extensions": {
    "io.github.charlaie.protonmail-mcp/binary-output": {
      "mimeTypes": ["application/pdf", "text/plain"]
    }
  }
}
```

For legacy initialization clients, `experimental` may be used instead of `extensions`. Modern clients provide the declaration in per-request client capabilities. A matching declaration produces `clientSupport: "declared"`; an empty list or a list missing the attachment's MIME type produces an `isError: true` text-only result explaining the required resource format. Compatibility checks run before approval or content download. Malformed declarations also produce detailed errors. Declarations never grant mail access or change the local extension allowlist, and do not guarantee that a client actually implements what it advertises.

### Adding attachment formats

Add the extension to `AttachmentExtensionSchema` and its complete definition in `src/attachments/formats.ts`. Each definition selects accepted MIME types and a decoded byte budget. The first registered MIME type is the canonical MIME type for raw resource delivery. The compiler rejects missing definitions, and terminal setup derives its extension list from the schema. New extensions remain disabled until the user selects them in setup. IMAP authorization, part selection, header checks, and bounded downloading stay in `src/bridge/attachments.ts`.

## Bridge diagnostics

These terminal commands use Bridge directly and bypass the MCP read policy and send approval:

```sh
pnpm bridge:list
pnpm bridge:search INBOX "search words"
pnpm bridge:read INBOX 123 456
pnpm bridge:send-test recipient@example.com
```

The `bridge:read` arguments are mailbox, UID, and UIDVALIDITY. `bridge:send-test` immediately sends a test email to the given recipient.

## Development checks

```sh
pnpm check
pnpm test
```

The test command builds the server and runs policy, approval, attachment validation, IMAP operation, and real stdio regressions. Attachment regressions cover byte preservation with the real IMAP downloader, metadata and size checks, and optional approval in both protocol flows. Tests use temporary policy/journal files, simulated Bridge connections, and a local ephemeral SMTP server with STARTTLS. They exercise SMTP rejection, partial acceptance, lost acknowledgments, restart recovery, competing draft sends/edits, and both approval protocol flows. They do not contact a live account or deliver real email. CI runs formatting, builds, and regressions on Linux and macOS, including the minimum Node.js version. Actual Bridge synchronization and client approval presentation still require the [test-account release checklist](docs/draft-send-release-checklist.md).
