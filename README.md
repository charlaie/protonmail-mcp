# protonmail-mcp

An MCP server for using Proton Mail through the local Proton Mail Bridge. It exposes tools to list mailboxes, search message metadata, read allowed plain-text messages, create and edit plain-text drafts, and send plain-text email after user approval.

## Requirements

- Node.js with ESM support
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

## Set Up Read Policy

Before the MCP can search or read messages, configure the local read allowlist:

```sh
pnpm setup
```

The setup command lists Bridge mailboxes and asks which mailboxes the model may search and read. You can also restrict reads by sender email or sender domain.

Draft tools also require the Drafts mailbox to be selected during setup. If Drafts is not allowed, draft tools return a policy error explaining how to enable access.

Useful policy commands:

```sh
pnpm policy
pnpm reset-policy
pnpm policy:check
```


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
- `search_messages`: searches allowed mailboxes and returns message summaries only.
- `get_message`: reads one allowed message by mailbox and UID as parsed plain text. HTML and attachments are not returned.
- `create_draft`: creates a plain-text draft in the Drafts mailbox and returns its IMAP UID when Bridge provides one.
- `edit_draft`: replaces an existing Drafts message by UID. IMAP does not edit message bodies in place, so this creates a replacement draft, deletes the old draft, and returns the new UID.
- `send_email`: sends a plain-text email through Proton Bridge SMTP. The server requests mandatory user approval before delivery.
