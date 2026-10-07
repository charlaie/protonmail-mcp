# protonmail-mcp

An MCP server for using Proton Mail through the local Proton Mail Bridge. It exposes tools to list mailboxes, search message metadata, read allowed plain-text messages, create and edit plain-text drafts, and send plain-text email after user approval.

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
- `get_thread`: reconstructs a reply chain across allowed mailboxes using exact Message-ID, References, and In-Reply-To tokens. This is a best-effort reconstruction. `limitReached` reports when the result cap is reached. `includeText: false` returns summaries; otherwise `bodyStatus` explains whether each body is included or unavailable. Total returned thread text is limited to 500,000 characters. Use `get_message` for bodies omitted by that limit.
- `create_draft`: saves a plain-text draft, including an empty composition, and returns its UID and UIDVALIDITY when Bridge provides them. It never sends mail.
- `edit_draft`: replaces the full contents of a plain-text draft using UID and UIDVALIDITY. Include every recipient, subject, and body value you want to retain; omitted values are cleared. Reply headers and the original sender alias are preserved. Drafts with HTML or attachments must be edited in Proton Mail. IMAP replacement creates a new draft and deletes the original. If deletion fails, the result includes the replacement identity and a recovery explanation. Inspect Drafts before retrying.
- `send_email`: sends plain-text email after mandatory user approval of the sender, recipients, subject, and complete formatted body. Bodies are limited to 100,000 characters. `partially_sent` identifies accepted and rejected recipients. On uncertain delivery, check Sent before retrying to avoid duplicates.

`get_message`, `get_thread`, and `edit_draft` require the `uidValidity` returned with the message identity. A mailbox reset invalidates old identities; search again before retrying. Tool failures set `isError: true`, including policy refusals and partial draft or email outcomes.

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

The test command builds the server and runs policy, approval, IMAP operation, and real stdio regressions. Tests use temporary policy files and a simulated Bridge boundary; they do not send email or connect to a live account.
