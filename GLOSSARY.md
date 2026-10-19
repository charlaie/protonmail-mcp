# Domain glossary

- **Bridge** is the local Proton Mail Bridge that exposes the account through IMAP and SMTP.
- **Mailbox** is an exact IMAP folder or label path. A path may be selectable or a namespace used to organize other paths.
- **Physical message identity** is the mailbox, UIDVALIDITY, and UID tuple. A UID identifies a message only within that mailbox and UIDVALIDITY.
- **UIDVALIDITY** is the mailbox generation returned by IMAP. A changed value invalidates previously observed UIDs.
- **Logical draft ID** is the account-scoped journal ID that follows a draft across server-managed replacements. It resolves to a physical message identity.
- **Draft revision** is the fingerprint of the exact draft bytes used to reject stale edits and changed snapshots.
- **Outgoing message** contains the sender, recipients, subject, text, reply headers, and optional media prepared for submission.
- **Media** is a bounded collection of outgoing attachment files and inline images. Its manifest describes the content without exposing the encoded bytes.
- **Operation ID** is the caller-supplied UUID for one intended write. Reusing it requires identical request arguments.
- **Operation journal** is the account-scoped SQLite record of draft, send, and inbox outcomes and their message claims.
- **Message claim** prevents conflicting draft, send, or inbox writes to the same message while an operation remains unresolved.
- **Reconciliation** checks available evidence after an uncertain write without repeating that write.
- **Read policy** grants mailbox and sender access, incoming attachment permissions, and explicit write capabilities for the account.
- **Send acceptance** means Bridge accepted SMTP submission. It does not establish recipient delivery.
