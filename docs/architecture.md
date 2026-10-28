# Source organization

Directories group code by ownership and composition. The entry modules show where those groups are assembled. Small features stay flat internally; subdirectories collect code with a more specific owner.

```text
src/
├── index.ts                         CLI dispatch and stdio startup
├── cli/
│   ├── setup/                       Guided account and permission setup
│   ├── clients/                     Client configuration and launch paths
│   ├── diagnostics/                 Bridge, journal, and MCP checks
│   └── policy.ts                    Policy inspection and reset commands
├── mcp/
│   ├── server.ts                    Compose the server and register features
│   ├── tools/
│   │   ├── reading/                 Read registrations and output schemas
│   │   ├── drafts/                  Draft registrations, schemas, and tests
│   │   ├── sending/                 Send registrations, schemas, and tests
│   │   ├── inbox/                   Inbox registrations, schemas, and tests
│   │   └── attachments/             Attachment registrations and approval tests
│   ├── protocol/                    Registry, annotations, elicitation, and responses
│   └── integration/                 Cross-feature checks and the test client
├── mail/
│   ├── access.ts                    Compose policy-authorized mail access
│   ├── identity.ts                  Physical mailbox identity
│   ├── message.ts                   Shared received-message contracts
│   ├── reading/                     Ordered batch reads and aggregate output budgets
│   ├── mailboxes.ts                 Selectable special-mailbox resolution
│   ├── drafts/
│   │   ├── workflow.ts              Authorized creation, reply composition, and replay
│   │   ├── service.ts               Draft identity, revisions, and recovery
│   │   ├── snapshots.ts             Inspect and fingerprint saved drafts
│   │   └── composition/             Compose new drafts and replies
│   ├── sending/
│   │   ├── workflow.ts              Replay, approval, and source rechecks
│   │   └── service.ts               Durable submission and cleanup outcomes
│   ├── inbox/
│   │   ├── service.ts               Claims, dispatch, and recorded outcomes
│   │   ├── evidence.ts              Message inspection and reconciliation evidence
│   │   └── mailboxes.ts             Placement plans and mailbox classification
│   ├── attachments/                 Incoming inspection and bounded downloads
│   └── outgoing/
│       ├── content.ts               Shared composition fields
│       ├── message.ts               Outgoing message contracts
│       ├── senders.ts               Configured sender selection
│       └── media/                   Payloads, inline images, and MIME conversion
├── bridge/
│   ├── config.ts                    Bridge connection configuration
│   ├── authorization.ts             Final write-authorization contract
│   ├── imap/
│   │   ├── service.ts               Compose mailbox access and mail workflows
│   │   ├── session.ts               IMAP connection lifecycle
│   │   ├── reading/                 Message reads, searches, and query contracts
│   │   └── threads/                 Reply-chain reconstruction and aliases
│   ├── smtp/                        Submission and transport outcomes
│   └── testing/                     IMAP fixtures and the SMTP test listener
├── operations/
│   ├── journal.ts                   Compose the account journal and integrity check
│   ├── identity.ts                  Operation UUID and lookup contracts
│   └── sqlite/                      Persistence, record access, and shared claims
├── policy/                          Access grants, evaluation, and persistence
├── config/                          Account profiles, paths, and settings commits
├── shared/                          Errors, content hashing, and private files
└── types/                           External declaration support
```

The tree above selects entry modules and groups rather than listing every file. Request contracts and models stay beside the feature that owns them. Tests stay beside their owner, with cross-feature MCP checks under `mcp/integration/`.

## Composition

`index.ts` selects a CLI command or starts `mcp/server.ts`. The MCP server constructs the journal, Bridge access, policy-authorized mail access, approval handling, and sending workflow. It registers each `mcp/tools/<feature>/register.ts` module. Protocol modules handle elicitation and translate results; mail modules own workflow decisions.

`mail/access.ts` applies the account's policy to Bridge operations and draft/inbox workflows. It reloads policy for final write authorization. `mail/sending/workflow.ts` owns approval sequencing and source rechecks; `mail/sending/service.ts` owns durable submission and separately reported draft cleanup.

`bridge/imap/service.ts` combines the session, message reads, thread reconstruction, draft workflow, inbox workflow, and attachment operations. Nesting the IMAP implementation does not make Bridge the owner of draft or inbox rules. Those rules remain under `mail/`.

IMAP composition takes named dependencies (`run`, `draftStore`, and `inboxStore`). Sending takes named `authorize` and `cleanup` callbacks. Callers can override one dependency without positional placeholders.

`operations/journal.ts` assembles typed draft, send, and inbox journal operations over the SQLite implementation. Cross-feature claims and draft lineage belong together under `operations/sqlite/` because all mutations must obey the same account journal.

`config/locks.ts` owns settings lock acquisition and release for account setup and client installation. Each caller holds its locks while checking the reviewed snapshots, saving files, and completing any rollback. `shared/private-file.ts` owns optional text reads and private staged file replacement.

## Workflow contracts

Sending uses one lifecycle for new mail, forwards, and saved drafts: check replay, compose, prepare, request approval, recheck source content, authorize, and submit. Forward plans require a source recheck; draft plans also require cleanup. The send service authorizes again after acquiring its durable claim and persists acceptance before cleanup.

Inbox changes track the current attempt separately from the durable journal outcome. A confirmed reservation can be aborted before dispatch. A confirmed dispatch can be aborted only while its owner knows the IMAP command has not started. A lost dispatch acknowledgement or a failure after starting the command retains uncertainty. Reconciliation gathers evidence through `inbox/evidence.ts` and never repeats a write.

Setup and runtime use `mail/mailboxes.ts` to resolve Drafts, Sent, Archive, and Trash. Server-declared roles take precedence over conventional folder names, and non-selectable namespaces are excluded.

Draft composition distinguishes creation from editing; an edit requires its parsed original. Composition produces MIME bytes without writing to IMAP. The draft service owns the journal claim and APPEND. `drafts/workflow.ts` coordinates mailbox authorization, reply-source reads, composition, and replay; MCP registrations only translate requests and responses.

Search pagination lives in `bridge/imap/reading/`: an ephemeral authenticated cursor binds the received-date/UID position and initial UID ceiling to the query, account and policy. Mail access supplies the current policy fingerprint; MCP handlers only translate the page. No result snapshots are persisted. `mail/reading/batch.ts` owns ordered batch outcomes and output budgets and calls the canonical authorized single-message read path sequentially.

Message and draft reads share the 10 MiB size rule for advertised sizes and actual fetched bytes. Both authorize parsed sender addresses before returning message content, in addition to checking the IMAP envelope before fetching it.

## Placement rules

- Put a workflow rule in its mail feature. Put protocol registration and result schemas in the corresponding MCP tool directory.
- Put reusable outgoing message/media rules under `mail/outgoing/`, rather than under one sending or draft workflow.
- Put connection and protocol details under `bridge/imap/` or `bridge/smtp/`.
- Keep shared reservation and schema initialization rules under `operations/sqlite/`; do not create separate journals per feature.
- Add a subdirectory when a set of modules has a specific owner. Keep small cohesive groups flat.
- Import the implementing file directly. Do not add barrel exports or forwarding modules to hide the directory structure.

## Imports

Use `@/` for imports across directories, rooted at `src/`, and keep `.js` extensions:

```ts
import { safeErrorMessage } from "@/shared/errors.js";
```

Keep same-directory imports relative, such as `./model.js`. TypeScript resolves the alias through `compilerOptions.paths` in `tsconfig.json`. After compilation, `pnpm build` uses `tsc-alias` to rewrite aliases to relative paths in `build/`, so the CLI and published package run directly in Node without a runtime loader. Use `pnpm build` rather than invoking `tsc` alone when producing runnable output.

`pnpm test` passes a quoted recursive pattern to Node so nested test files are discovered on every supported shell. Package exclusions keep tests, fixtures, and `testing/` directories out of the published runtime.

TypeScript checks unchecked indexed access, missing return paths, and switch fallthrough in addition to strict mode. Tests must establish that a fetched array element exists before inspecting it.
