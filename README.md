# protonmail-mcp

An MCP server for using Proton Mail through the local Proton Mail Bridge. It exposes tools to list mailboxes, search message metadata, read allowed plain-text messages and download original attachments, create and edit plain-text drafts and replies, and send approved plain-text messages or draft snapshots with durable recovery.

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

Policies are bound to the Bridge username used during setup. Existing version 1 policies and policies for another account cannot authorize reads or draft access. Run `pnpm setup` to create a version 2 policy for the current account. Setup replaces the policy file atomically.

Draft tools also require the Drafts mailbox to be selected during setup. If Drafts is not allowed, draft tools return a policy error explaining how to enable access.
Sender restrictions govern reading drafts. Draft creation and replacement require mailbox access independently of those sender restrictions.

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
- `create_draft`: saves a plain-text draft, including an empty composition, and returns its UID and UIDVALIDITY when Bridge provides them. It never sends mail.
- `create_reply_draft`: creates a reply or reply-all draft from an allowed mailbox, UID, and UIDVALIDITY. It respects Reply-To, excludes configured own addresses, deduplicates recipients, never copies original Bcc recipients, and derives In-Reply-To and References. `replyAll` defaults to false; `text` may be empty. Requires source read permission and Drafts access. It never sends mail.
- `edit_draft`: replaces the full contents of a plain-text draft using UID and UIDVALIDITY. Include every recipient, subject, and body value you want to retain; omitted values are cleared. Reply headers and the original sender alias are preserved. Drafts with HTML or attachments must be edited in Proton Mail. IMAP replacement creates a new draft and deletes the original. If deletion fails, the result includes the replacement identity and a recovery explanation. Inspect Drafts before retrying.
- `send_email`: sends plain-text email after mandatory user approval of the sender, recipients, subject, reply metadata, and complete formatted body. Bodies are limited to 100,000 characters. Requires a new `operationId` UUID for each intended send; repeat the same ID and arguments to retrieve an attempted operation's outcome without submitting it again.
- `send_draft`: sends a plain-text Drafts snapshot identified by UID and UIDVALIDITY after full-message approval. Requires an `operationId` UUID and account, mailbox, and sender read permission. It preserves the draft's recipients, Bcc, sender, subject, text, Reply-To, and threading headers. HTML, attachments, invalid headers, unconfigured sender aliases, and oversized drafts are refused. Changing the snapshot requires a new operation and approval. After full SMTP acceptance, it checks the snapshot again before deleting only that draft with UIDPLUS. Deletion is a separately reported outcome; a deletion failure never triggers another send.
- `get_send_operation`: retrieves the current account's durable operation record by `operationId`, including after a restart. It never sends mail. Interrupted submissions are reported as uncertain.
- `reconcile_send_operation`: searches the policy-allowed Sent mailbox for an uncertain operation's exact preassigned Message-ID. Positive evidence records matching identities in `sentCopies`, separately from the SMTP outcome. No match leaves the operation uncertain. It never resends or deletes drafts.

`get_message`, `get_thread`, `list_attachments`, `get_attachment`, `create_reply_draft`, `send_draft`, and `edit_draft` require the `uidValidity` returned with the message identity. A mailbox reset invalidates old identities; search again before retrying. Tool failures set `isError: true`, including policy refusals and partial draft or email outcomes. Tools advertise output schemas and return `structuredContent` alongside JSON text for older clients. Ordinary errors have `{ status: "error", error: { code, message, retry } }`. Retry guidance distinguishes safe retry, refreshed identity, configuration changes, renewed approval, reconciliation, and no retry.

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

The SQLite journal defaults to `send-operations/` beside the policy file. Set `PROTONMAIL_MCP_OPERATIONS_DIR` to choose another local directory. Each account has a separate database with private file permissions. Records contain request/content hashes and outcome metadata, not message bodies or Bridge passwords. Keep the journal when moving configurations or recovering a server; deleting it removes replay protection. Use a local filesystem and share this directory among MCP processes for the same account. SQLite commits use synchronous FULL durability; interrupted or unrecorded SMTP outcomes stay uncertain and block automatic retries.

A Message-ID correlates a submission with Sent; it does not guarantee SMTP deduplication or exactly-once delivery. A Sent copy does not prove delivery to every recipient. Do not create a replacement operation ID merely because an acknowledgment was lost. Resolve uncertainty using the recorded ID and Sent evidence first.

Draft edits and sends serialize mutations to the same identity within one process, then recheck content before destructive cleanup. If a replacement is saved but deleting the original fails, further edits of that original return the first replacement's recovery details. An uncertain append also blocks further mutations of that original. These edit guards last for the process lifetime; inspect Drafts before restarting after a partial edit, and use the replacement's identity for subsequent edits. Sending claims also coordinate across processes sharing the journal. Editing in other processes or mail clients is not a transaction with this server. External changes detected during approval or cleanup are refused or retained; an external client can still act between the final check and SMTP submission.

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

The test command builds the server and runs policy, approval, attachment validation, IMAP operation, and real stdio regressions. Attachment regressions cover byte preservation with the real IMAP downloader, metadata and size checks, and optional approval in both protocol flows. Tests use temporary policy/journal files, simulated Bridge connections, and a local ephemeral SMTP server with STARTTLS. They exercise SMTP rejection, partial acceptance, lost acknowledgments, restart recovery, competing draft sends/edits, and both approval protocol flows. They do not contact a live account or deliver real email. CI runs formatting, builds, and regressions on Linux and macOS, including the minimum Node.js version. Actual Bridge synchronization and client approval presentation still require a separate test-account release check.
