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
│   ├── protocol/                    Registry, elicitation, and response handling
│   └── integration/                 Cross-feature checks and the test client
├── mail/
│   ├── access.ts                    Compose policy-authorized mail access
│   ├── identity.ts                  Physical mailbox identity
│   ├── message.ts                   Shared received-message contracts
│   ├── drafts/
│   │   ├── service.ts               Draft identity, revisions, and recovery
│   │   ├── snapshots.ts             Inspect and fingerprint saved drafts
│   │   └── composition/             Compose new drafts and replies
│   ├── sending/
│   │   ├── workflow.ts              Replay, approval, and source rechecks
│   │   └── service.ts               Durable submission and cleanup outcomes
│   ├── inbox/                       Placement, flags, and mailbox creation
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
│   └── sqlite/                      Persistence, migrations, and shared claims
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

`operations/journal.ts` assembles typed draft, send, and inbox journal operations over the SQLite implementation. Cross-feature claims and draft lineage belong together under `operations/sqlite/` because all mutations must obey the same account journal.

## Placement rules

- Put a workflow rule in its mail feature. Put protocol registration and result schemas in the corresponding MCP tool directory.
- Put reusable outgoing message/media rules under `mail/outgoing/`, rather than under one sending or draft workflow.
- Put connection and protocol details under `bridge/imap/` or `bridge/smtp/`.
- Keep shared reservation and migration rules under `operations/sqlite/`; do not create separate journals per feature.
- Add a subdirectory when a set of modules has a specific owner. Keep small cohesive groups flat.
- Import the implementing file directly. Do not add barrel exports or forwarding modules to hide the directory structure.

## Imports

Use `@/` for imports across directories, rooted at `src/`, and keep `.js` extensions:

```ts
import { safeErrorMessage } from "@/shared/errors.js";
```

Keep same-directory imports relative, such as `./model.js`. TypeScript resolves the alias through `compilerOptions.paths` in `tsconfig.json`. After compilation, `pnpm build` uses `tsc-alias` to rewrite aliases to relative paths in `build/`, so the CLI and published package run directly in Node without a runtime loader. Use `pnpm build` rather than invoking `tsc` alone when producing runnable output.

`pnpm test` passes a quoted recursive pattern to Node so nested test files are discovered on every supported shell. Package exclusions keep tests, fixtures, and `testing/` directories out of the published runtime.
