# protonmail-mcp

An MCP server for using Proton Mail through the local Proton Mail Bridge. It exposes tools to list mailboxes, search message metadata, read allowed plain-text messages and attachments, create and edit plain-text drafts, and send plain-text email after user approval.

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

Setup also asks which attachment extensions may be inspected. Supported values are `.txt`, `.csv`, `.tsv`, `.md`, `.json`, and `.pdf`. Enter the extensions with their leading dots, separated by commas. Blank disables attachment content reads. Existing version 2 policies that omit `allowedAttachmentExtensions` also disable attachment reads; run `pnpm setup` to enable them. Attachment metadata remains available for allowed messages. The model cannot change this allowlist through tool arguments.

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

- `list_mailboxes`: lists Proton Bridge IMAP mailboxes and whether each is allowed by the read policy.
- `search_messages`: returns the newest allowed summaries by received date. Sender filtering happens before the result limit. Each summary includes `uid` and `uidValidity`.
- `get_message`: reads one allowed message by mailbox, UID, and UIDVALIDITY. HTML-only messages are converted to plain text. Attachment contents are omitted. Messages larger than 10 MiB must be read in Proton Mail.
- `list_attachments`: lists filename, MIME type, transfer-encoded size, attachment ID, and inspection eligibility for an allowed message. Fetches MIME structure without downloading attachment contents. Eligibility describes policy and metadata checks; reading also validates actual headers and content.
- `get_attachment`: reads one attachment ID returned by `list_attachments`, using the same mailbox, UID, and UIDVALIDITY. Downloads only that part, even if the whole message exceeds the message-read limit. Returns inert plain text and marks it as untrusted. Text attachments must be UTF-8 or ASCII and no larger than 1 MiB. PDF attachments must be no larger than 5 MiB and 50 pages. Returned text is capped at 100,000 characters with explicit `truncated` reporting.
- `get_thread`: reconstructs a reply chain across allowed mailboxes using exact Message-ID, References, and In-Reply-To tokens. This is a best-effort reconstruction. `limitReached` reports when the result cap is reached. `includeText: false` returns summaries; otherwise `bodyStatus` explains whether each body is included or unavailable. Total returned thread text is limited to 500,000 characters. Use `get_message` for bodies omitted by that limit.
- `create_draft`: saves a plain-text draft, including an empty composition, and returns its UID and UIDVALIDITY when Bridge provides them. It never sends mail.
- `edit_draft`: replaces the full contents of a plain-text draft using UID and UIDVALIDITY. Include every recipient, subject, and body value you want to retain; omitted values are cleared. Reply headers and the original sender alias are preserved. Drafts with HTML or attachments must be edited in Proton Mail. IMAP replacement creates a new draft and deletes the original. If deletion fails, the result includes the replacement identity and a recovery explanation. Inspect Drafts before retrying.
- `send_email`: sends plain-text email after mandatory user approval of the sender, recipients, subject, and complete formatted body. Bodies are limited to 100,000 characters. `partially_sent` identifies accepted and rejected recipients. On uncertain delivery, check Sent before retrying to avoid duplicates.

`get_message`, `get_thread`, `list_attachments`, `get_attachment`, and `edit_draft` require the `uidValidity` returned with the message identity. A mailbox reset invalidates old identities; search again before retrying. Tool failures set `isError: true`, including policy refusals and partial draft or email outcomes.

## Attachment inspection

Attachment tools enforce account, mailbox, and sender policy before accessing message MIME structure or downloading a part. They reject unsafe filenames, unsupported or disabled extensions, missing sizes, MIME mismatches, invalid UTF-8, and binary control data. MIME headers and filenames are sender-controlled. `application/octet-stream` is accepted only with an allowed extension and the same content validation. Sizes from IMAP structure are transfer-encoded estimates; downloads enforce the decoded byte limit independently.

Markdown and JSON are returned as text. The tools never render markup, evaluate CSV formulas, execute scripts, follow embedded links, or unpack containers. Attached messages and archives cannot authorize reads of their nested contents. Attachment text and metadata can contain prompt injection; treat them as source material, never as instructions or authorization to use tools. Sender allowlisting checks the From header and does not establish that a sender is authentic. Email sending retains its mandatory approval.

PDF inspection currently requires macOS and `/usr/bin/sandbox-exec`. Linux, Windows, and environments that prohibit starting the OS sandbox refuse PDF reads. There is no unsandboxed fallback. Text inspection and metadata listing remain available on those platforms.

The pinned PDF.js extractor runs in a separate, temporary OS sandbox with a clean environment and copies of only the parser code and font/CMap assets. It can read those files, the Node executable, and required OS libraries. It cannot read Bridge credentials or the policy file, write files, access the network, or fork processes. Temporary files contain parser assets, not attachment contents, and are removed after each request. Document scripts and dynamically generated code cannot execute, and native addons and rendering are disabled.

One PDF extraction runs at a time; concurrent requests receive a retry explanation. PDF extraction has a 10 second wall-clock timeout, a 128 MiB V8 heap budget, a 256 MiB resident-memory watchdog sampled every 50 ms, and a bounded output pipe. The watchdog terminates a process that exceeds its budget; it is not a kernel-enforced instantaneous memory ceiling. Password-protected, malformed, and over-limit PDFs return errors. PDFs without extractable text return `status: "ocr_required"` with an explanation. OCR is not performed. Extracted text may lose document layout.

### Adding attachment formats

Add the extension to `AttachmentExtensionSchema` and its complete definition in `src/attachments/formats.ts`. Each definition must select MIME types, a decoded byte budget, and a decoder. Text definitions also specify allowed character sets. The compiler rejects missing definitions, and terminal setup derives its extension list from the schema. The catalog contains only metadata so policy parsing never loads extraction code.

Formats that should be read as inert UTF-8 text can reuse `utf8_text`. A new decoder requires a new variant in `FormatDefinition` and explicit handling in `attachmentHeaderError` and `inspectAttachment`. Both switches are exhaustive; there is no default text decoder. IMAP authorization, part selection, and bounded downloading stay in `src/bridge/attachments.ts`.

Document parsers must preserve OS isolation and resource limits. The policy module supplies protected file paths through the attachment-read context; extractors pass them to the sandbox launcher, which normalizes and denies those paths. Keep parser staging and result validation within the extractor, and add real extraction and refusal regressions. New extensions remain disabled until the user selects them in terminal setup.

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

The test command builds the server and runs policy, approval, attachment validation, IMAP operation, and real stdio regressions. On macOS it also exercises real sandboxed PDF extraction, denial of private file access, network and process restrictions, and timeout/memory/output limits. Those tests require permission to start `sandbox-exec`; an enclosing sandbox may prohibit it. Tests use temporary policy files and a simulated Bridge connection; they do not send email or connect to a live account.
