# Configuration and migration

The version 1 server config contains `bridge` settings and optional `storage` paths. Unknown fields are rejected. Environment credentials and `.env` loading have been removed.

```json
{
  "version": 1,
  "bridge": {
    "user": "your-bridge-username",
    "password": "your-bridge-password",
    "host": "127.0.0.1",
    "imapPort": 1143,
    "smtpPort": 1025,
    "tlsRejectUnauthorized": false,
    "ownAddresses": []
  },
  "storage": {
    "policyFile": "read-policy.json",
    "operationsDirectory": "send-operations"
  }
}
```

`user` and `password` are required. Other Bridge values have the defaults shown. `ownAddresses` contains this account's sender aliases. The Bridge username is included automatically. These addresses are the allowed `from` choices for new emails, forwards, drafts, and reply drafts. They also exclude self from reply-all and validate draft senders. Configure addresses already enabled for sending on your Proton account; adding an address here does not create or enable it in Proton. Restart the MCP server after changing aliases to refresh the advertised choices.

Relative storage paths resolve beside the config file. If `storage` is omitted for the default profile, the previous policy default remains `~/.config/protonmail-mcp/read-policy.json`. Additional profiles use `<config filename>.policy.json` beside their config: `accounts/work.json` uses `accounts/work.json.policy.json`. All profiles default to the original `~/.config/protonmail-mcp/send-operations` journal directory, where databases are keyed by account. Processes for the same account must share that directory to retain replay protection. Full setup writes explicit absolute paths and refuses to overwrite another account's policy.

The config and policy files use atomic replacement and owner-only file permissions on POSIX systems. They contain the Bridge password and permission grants respectively. On Windows, access follows the user's profile and filesystem ACLs. Client configurations contain no Bridge password.

Setup validates and stages both files before saving, locks their paths against other setup sessions, and refuses changes made since review. If saving the config fails, it restores the previous policy. The pair of files is not crash-atomic: after an interrupted save, inspect both files before restarting the server. A stale `.setup.lock` file should be removed only after confirming the previous setup process has stopped.

## Migrate an existing installation

1. Stop the running MCP servers.
2. Run `pnpm run setup` in the checkout, or `protonmail-mcp setup` from an installed package.
3. Enter the Bridge credentials previously held in `.env` or client environment variables.
4. If you previously set custom policy/journal locations, choose existing custom storage and enter those paths. Setup cannot recover removed environment settings automatically.
5. Review the permissions and save the version 3 policy. Existing mailbox and sender selections are retained only for the matching account. Version 1 and 2 policies do not authorize mail access until reviewed; mail-changing tools need explicit grants.
6. Generate or merge the new client entries, then restart those clients' MCP servers.
7. Run `doctor` with the same config file.

Default setup preserves the old default policy and journal locations, including on macOS and Windows. Custom config files use separate storage when created through setup. Keep existing journals and their account databases during upgrades and recovery. A fresh, deleted, or stale-restored journal loses replay protection.

## Access policy

The [policy example](../policy.example.json) shows version 3. `allowedTools` is an exact allowlist; `[]` grants no tools while the policy is valid. The tool names are listed in the [tool reference](tool-reference.md).

`allowedMailboxes` contains exact Bridge paths. Both sender lists empty means all senders in those mailboxes. Otherwise a sender matches an exact email OR an exact domain. Sender restrictions also apply to draft reads and edits, so include your own sender address or domain when appropriate.

`allowedAttachmentExtensions` contains extensions with leading dots, such as `.pdf` or `.zip`; `*` permits all files, including extensionless files. Downloads also require `get_attachment` in `allowedTools`. Attachment metadata is independent of download permission. The wizard defaults new download grants to requiring approval.

`inboxWrites` is disabled by default. An enabled policy grants individual actions and exact writable mailbox paths, each of which must already be readable. Inbox changes also require `manage_message` in `allowedTools`. These actions have no per-action human approval. Sending always has a separate mandatory approval.

Folder and label creation requires `create_mailbox` in `allowedTools` and the corresponding kind in `mailboxCreation`, such as `["folder", "label"]`. The default is `[]`, including for existing policies. Setup offers these grants separately from message actions. Creation applies to custom mailboxes under Bridge's advertised `Folders` and `Labels` namespaces. It does not grant read or message-write access to the resulting path. Add those exact paths through setup before reading or organizing mail in them. Creation has no per-action approval once granted.

Draft creation and editing require their individual tool grants and readable Drafts access. Sending a draft includes deletion of its unchanged snapshot after full acceptance; editing a draft includes deletion of its unchanged original. Cleanup retry tools have separate grants. Read-only mode excludes all of these mail-changing tools.

Tool grants are reloaded at invocation and immediately before mail writes, including after approval, preflight, and journal claims. Revocation stops writes that have not yet been dispatched; it cannot undo a command already sent to Bridge. Inbox reconciliation requires its own tool grant and mailbox/sender read access, so uncertain prior writes can be inspected after switching to read-only mode.

When authorization fails before a command is sent, draft operations become `rejected` and inbox operations become `aborted`. Their IDs stay terminal, but their message reservations are released. After restoring permissions, a newly reviewed request can use a new operation ID. Commands whose acknowledgments were lost retain their uncertain outcomes and reservations.

## Advanced connection settings

STARTTLS remains mandatory for both IMAP and SMTP. Certificate verification can be disabled only for literal loopback IPs or `localhost`, which is pinned to `127.0.0.1`. Remote hosts require `bridge.tlsRejectUnauthorized: true` and a trusted certificate. A remote self-signed certificate must be explicitly trusted, for example through Node's `NODE_EXTRA_CA_CERTS`.

## Client integration

Client generators currently support Claude Desktop, Codex, VS Code, and Cursor. They produce native client formats with absolute Node, entry point, and config paths. For persistent npm/PNPM installations with a public `node_modules/protonmail-mcp` entry, generators verify that it resolves to the running server and retain that public path. PNPM can replace the package-store version behind its link during an update without invalidating the client configuration. The generated command invokes Node directly on every platform, including Windows, without requiring shell wrappers or a desktop application's `PATH`.

Source checkouts retain their checkout path. If no matching public package entry can be verified, generators retain the supplied entry path. This fallback keeps setup and doctor usable on other layouts, but temporary `npx`/`pnpm dlx` caches and unlinked package-store paths do not provide an enduring client entry. Use a persistent installation before saving client entries. Restart MCP servers after updating. Existing entries that point into a versioned package store need a one-time refresh using `protonmail-mcp setup --section client` with the same `--config` path. If you replace or move Node, move the installation, or change package managers, regenerate the entries. Account configuration, policy, and the operation journal remain in their configured locations.

MCP defines the communication protocol; hosts still use different local configuration and installation formats. The generators handle those differences. Generated configuration does not establish compatibility with every client version. Full approval presentation and original-byte attachment handling require live client checks.
