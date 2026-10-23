# Configuration

The version 1 server config contains `bridge` settings and optional `storage` paths. Unknown fields are rejected. Credentials are read only from this file.

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

Additional sender addresses must be entered manually during setup. Bridge does not expose an address list over IMAP/SMTP. Its internal GUI gRPC API has an address list, but the GUI normally deletes the connection file after reading it, so it cannot support reliable discovery during a running GUI session. This limitation was confirmed with Bridge 3.27.1. Setup retains saved aliases when editing the same account and starts with an empty alias field when changing the Bridge username.

Relative storage paths resolve beside the config file. Default storage uses the platform's configuration directory: `$XDG_CONFIG_HOME/protonmail-mcp` (or `~/.config/protonmail-mcp`) on Linux, `~/Library/Application Support/protonmail-mcp` on macOS, and `%APPDATA%/protonmail-mcp` on Windows. The default profile uses `read-policy.json` in that directory. Additional profiles use `<config filename>.policy.json` beside their config: `accounts/work.json` uses `accounts/work.json.policy.json`. All profiles default to the `send-operations` directory under the platform configuration directory, where databases are keyed by account. Processes for the same account must share that directory to retain replay protection. Full setup writes explicit absolute paths and refuses to overwrite another account's policy.

The config and policy files use atomic replacement and owner-only file permissions on POSIX systems. They contain the Bridge password and permission grants respectively. On Windows, access follows the user's profile and filesystem ACLs. Client configurations contain no Bridge password.

Setup validates and stages both files before saving, locks their paths against other setup sessions, and refuses changes made since review. If saving the config fails, it restores the previous policy. The pair of files is not crash-atomic: after an interrupted save, inspect both files before restarting the server. A stale `.setup.lock` file should be removed only after confirming the previous setup process has stopped.

Client configuration installation uses the same path locks while checking the reviewed file, backing it up, and saving the merge. Concurrent installations cannot overwrite each other's reviewed changes. Each backup has a unique `.bak` filename so successive installations retain their separate originals. Other applications that edit the file do not participate in these locks.

## Development storage

Only the current formats are supported: config version 1, policy version 3, and journal schema version 1. There are no policy conversions or journal backfills. Run setup to replace an unsupported policy and review all permissions again. Every policy field in the [example](../policy.example.json) is required; unknown fields are rejected.

Unversioned and unsupported journals are refused without rewriting their records. Preserve them for manual inspection of prior writes. After resolving pending operations, configure a separate `storage.operationsDirectory` for a fresh development state. A fresh, deleted, or stale-restored journal loses replay protection for earlier operations. Do not retry prior writes under new operation IDs just because a new journal has no record of them.

Saved absolute storage paths remain in effect, and setup reuses them. To change locations, edit `storage.policyFile` and `storage.operationsDirectory` directly in the config. Preserve prior journals for recovery; no files are moved automatically.

## Access policy

The [policy example](../policy.example.json) shows version 3. `allowedTools` is an exact allowlist; `[]` grants no tools while the policy is valid. The tool names are listed in the [tool reference](tool-reference.md).

`allowedMailboxes` contains exact Bridge paths. Both sender lists empty means all senders in those mailboxes. Otherwise a sender matches an exact email OR an exact domain. Sender restrictions also apply to draft reads and edits, so include your own sender address or domain when appropriate.

`allowedAttachmentExtensions` contains extensions with leading dots, such as `.pdf` or `.zip`; `*` permits all files, including extensionless files. Downloads also require `get_attachment` in `allowedTools`. Attachment metadata is independent of download permission. The wizard defaults new download grants to requiring approval.

`inboxWrites` is disabled by default. An enabled policy grants individual actions and exact writable mailbox paths, each of which must already be readable. Inbox changes also require `manage_message` in `allowedTools`. These actions have no per-action human approval. Sending always has a separate mandatory approval.

Folder and label creation requires `create_mailbox` in `allowedTools` and the corresponding kind in `mailboxCreation`, such as `["folder", "label"]`. The policy constructor defaults this field to `[]`. Setup offers these grants separately from message actions. Creation applies to custom mailboxes under Bridge's advertised `Folders` and `Labels` namespaces. It does not grant read or message-write access to the resulting path. Add those exact paths through setup before reading or organizing mail in them. Creation has no per-action approval once granted.

Draft creation and editing require their individual tool grants and readable Drafts access. Sending a draft includes deletion of its unchanged snapshot after full acceptance; editing a draft includes deletion of its unchanged original. Cleanup retry tools have separate grants. Read-only mode excludes all of these mail-changing tools.

Tool grants are reloaded at invocation and immediately before mail writes, including after approval, preflight, and journal claims. Revocation stops writes that have not yet been dispatched; it cannot undo a command already sent to Bridge. Inbox reconciliation requires its own tool grant and mailbox/sender read access, so uncertain prior writes can be inspected after switching to read-only mode.

When authorization fails before a command is sent, draft operations become `rejected` and inbox operations become `aborted`. Their IDs stay terminal, but their message reservations are released. After restoring permissions, a newly reviewed request can use a new operation ID. Commands whose acknowledgments were lost retain their uncertain outcomes and reservations.

## Advanced connection settings

STARTTLS remains mandatory for both IMAP and SMTP. Certificate verification can be disabled only for literal loopback IPs or `localhost`, which is pinned to `127.0.0.1`. Remote hosts require `bridge.tlsRejectUnauthorized: true` and a trusted certificate. A remote self-signed certificate must be explicitly trusted, for example through Node's `NODE_EXTRA_CA_CERTS`.

## Client integration

Client generators currently support Claude Desktop, Codex, VS Code, and Cursor. They produce native client formats with absolute Node, entry point, and config paths. For persistent npm/PNPM installations with a public `node_modules/protonmail-mcp` entry, generators verify that it resolves to the running server and retain that public path. PNPM can replace the package-store version behind its link during an update without invalidating the client configuration. The generated command invokes Node directly on every platform, including Windows, without requiring shell wrappers or a desktop application's `PATH`.

Source checkouts retain their checkout path. If no matching public package entry can be verified, generators retain the supplied entry path. This fallback keeps setup and doctor usable on other layouts, but temporary `npx`/`pnpm dlx` caches and unlinked package-store paths do not provide an enduring client entry. Use a persistent installation before saving client entries. Restart MCP servers after updating. Existing entries that point into a versioned package store need a one-time refresh using `protonmail-mcp setup --section client` with the same `--config` path. If you replace or move Node, move the installation, or change package managers, regenerate the entries. Account configuration, policy, and the operation journal remain in their configured locations.

MCP defines the communication protocol; hosts still use different local configuration and installation formats. The generators handle those differences. Generated configuration does not establish compatibility with every client version. Full approval presentation and original-byte attachment handling require live client checks.
