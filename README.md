# protonmail-mcp

Connect Claude Desktop, Codex, VS Code, or Cursor to Proton Mail through your local Proton Mail Bridge. Choose which mailboxes the assistant can read and which tools it can use. You can allow attachment downloads, draft creation, message organization, and sending. Every send requires your approval.

## Requirements

- Node.js 22.16 or newer.
- Proton Mail Bridge installed, running, and signed in to a paid account. See [Proton's Bridge requirements](https://proton.me/support/bridge-linux-login-error).
- The IMAP/SMTP username and password displayed in Bridge, not your Proton account password.
- PNPM to install from source.

## Quick start

Clone the repository and run setup:

```sh
git clone https://github.com/charlaie/protonmail-mcp.git
cd protonmail-mcp
pnpm install --frozen-lockfile
pnpm run setup
```

Use `pnpm run setup`, including `run`. `pnpm setup` is PNPM's own setup command.

The terminal wizard checks your Bridge credentials over IMAP and SMTP without sending mail. Choose read-only access or select individual tools, then choose the mailboxes they can access. Depending on those choices, setup also asks about sender restrictions, attachment downloads, and inbox actions. Review the permissions before saving.

Choose your MCP clients at the end. Setup generates their configuration entries. You can copy an entry, save it to a file, or review and merge it into an existing client configuration. Setup backs up client files before changing them. For VS Code, use its MCP configuration editor to find the file for your user profile.

Restart your client or its MCP server as instructed. Ask the assistant to list your allowed mailboxes, then search one of them. Keep Bridge running and signed in.

For a persistently installed package, run `protonmail-mcp setup` instead. Setup uses the package's public `node_modules/protonmail-mcp` link when it points to the running installation. Package updates can replace the version behind that link without changing the client entry. Node runs the JavaScript entry directly, so starting the server does not depend on a desktop client's `PATH` or on Windows command wrappers. Use a persistent installation for lasting client entries. One-off `pnpm dlx` and `npx` cache paths may disappear.

## Configuration and permissions

The server reads its settings from a versioned JSON config file. It no longer loads `.env` files or `PROTONMAIL_*` environment variables. Setup saves your Bridge credentials in this file. Client entries contain the paths needed to launch the server and load its config.

Default server config locations:

| Platform | Location |
| --- | --- |
| Linux | `$XDG_CONFIG_HOME/protonmail-mcp/config.json`, or `~/.config/protonmail-mcp/config.json` |
| macOS | `~/Library/Application Support/protonmail-mcp/config.json` |
| Windows | `%APPDATA%/protonmail-mcp/config.json` |

Use `--config /absolute/path/config.json` on any command to choose another account configuration. Relative storage paths inside the config resolve beside that file, regardless of the client's working directory. See [the config example](config.example.json) and [configuration and migration](docs/configuration.md).

The version 3 access policy grants individual tools through `allowedTools`. At startup, the server hides and disables tools missing from this list. It checks grants on every call and again immediately before changing mail, including after send approval. Restart running servers after editing permissions to refresh the tool list. Revoked grants take effect even if a client still shows the old list.

Read-only setup excludes every tool that changes mail, including tools that create or edit drafts, send messages, organize the inbox, or delete drafts after a send or edit. You can enable attachment downloads separately. Mailbox and sender rules apply to all reads. Inbox changes require permission for the tool, the action, and both the source and destination mailboxes.

Tools that inspect saved operation records remain available if the policy is missing, invalid, outdated, or belongs to another account. This lets you inspect recovery records without reading message bodies or changing mail. Once you have a valid policy for the account, `allowedTools` controls these tools too.

## Change settings or add another client

After building, invoke the executable directly:

```sh
node build/index.js setup --section credentials
node build/index.js setup --section permissions
node build/index.js setup --section client
node build/index.js policy
```

To configure another account, use a separate config file and client entry name:

```sh
node build/index.js setup --config /absolute/path/work/config.json --name protonmail-work
```

Setup keeps your existing choices for the same account. Each account needs its own permission grants. All server processes using the same Bridge account should share its existing operation journal.

To generate client entries without the wizard:

```sh
node build/index.js client-config --client claude
node build/index.js client-config --client codex
node build/index.js client-config --client vscode
node build/index.js client-config --client cursor
```

Add `--output /path/to/new-snippet` to save a new file. Use `--install /path/to/client-config` to preview the merged configuration and confirm the change in your terminal. Add `--name protonmail-work` for a separate account entry. When merging TOML, the server preserves settings but reformats the document. For JSONC, it preserves comments outside the replaced entry. Both formats get a backup of the original file.

After upgrading an installed package, restart its MCP servers to load the new version. To replace a client entry generated by an older release, run `protonmail-mcp setup --section client` once with the same `--config` path. Moving the installation, changing Node installations, or moving a source checkout still requires regenerating client entries. Keep the existing config, policy, and operation journal when upgrading.

## Troubleshooting

```sh
pnpm doctor
node build/index.js doctor --json
node build/index.js doctor --config /absolute/path/config.json
```

Doctor checks your configuration and IMAP/SMTP credentials. It checks that the policy belongs to the account, the selected mailboxes exist, and the operation journal is accessible and passes SQLite's integrity check. It also launches the server from outside the repository and checks the MCP handshake. It sends no mail.

If a required check fails, doctor exits with code 1 and suggests a fix. Approval forms and attachment handling need testing inside your chosen client. Doctor reports these as unverified.

| Problem | Next step |
| --- | --- |
| No config file | Run setup in an interactive terminal, using the same `--config` path as the client. |
| Bridge refuses the connection | Open Bridge, sign in, and verify the configured host and ports. |
| Authentication fails | Copy the credentials from Bridge's account settings. |
| A tool is missing or denied | Run setup's permissions section, grant the tool and its required mailbox and action permissions, then restart the MCP server. |
| A policy predates version 3 | Run setup to review explicit tool grants. |
| Sending has no usable approval form | Check that your client supports the server's approval flow. The server requires approval before sending. |
| Attachments are not exposed as files | Use a client that handles embedded binary resources, or download them in Proton Mail. |

`reset-policy` removes only the access policy after terminal confirmation. It keeps the operation journal. Do not delete the journal to fix an uncertain draft or send.

## Reference and development

See [configuration and migration](docs/configuration.md), [tool contracts and recovery](docs/tool-reference.md), and the [Bridge and client testing checklist](docs/draft-send-release-checklist.md).

```sh
pnpm check
pnpm test
pnpm pack --pack-destination /tmp
```

Node scripts build the project on Linux, macOS, and Windows. Tests use temporary files, a simulated IMAP server, real MCP transports, and a local SMTP server. They do not deliver real email. The package archive includes compiled code and examples, so users of an installed package do not need to compile TypeScript. `pnpm pack` creates the archive without publishing it.
