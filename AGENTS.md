# Repository Guidelines

## Project Structure & Module Organization

This is a TypeScript MCP server for Proton Mail via Proton Bridge. Source lives in `src/` and compiles to `build/`.

- `src/index.ts` is the CLI entry point and MCP stdio startup.
- `src/cli/` contains setup commands, client configuration, policy commands, and diagnostics.
- `src/mcp/server.ts` composes the MCP server; `tools/` groups registrations and schemas by mail feature, `protocol/` holds shared protocol behavior, and `integration/` holds cross-feature checks.
- `src/mail/access.ts` composes policy-authorized access to the mail features.
- `src/mail/drafts/`, `sending/`, `inbox/`, and `attachments/` own their respective mail workflows and contracts. Draft composition lives in `drafts/composition/`.
- `src/mail/outgoing/` owns shared outgoing content and sender selection; `media/` owns payload validation, images, and MIME conversion.
- `src/bridge/` owns Bridge configuration and write authorization contracts. `imap/` contains connection and mailbox operations, with `reading/` and `threads/` grouped separately; `smtp/` owns submission. `testing/` contains transport fixtures.
- `src/operations/journal.ts` composes the account journal; `sqlite/` owns persistence, migrations, message claims, and draft identity bindings.
- `src/policy/` owns policy schemas, persistence, evaluation, and checks.
- `src/config/` owns account configuration and storage locations.
- `src/shared/` contains cross-cutting helpers such as error formatting.

Directory nesting describes ownership. Keep composition visible in the entry modules above and import implementation modules directly; do not add forwarding barrels. Keep tests beside their owner, with cross-feature MCP checks in `mcp/integration/`.

See [docs/architecture.md](docs/architecture.md) for the source map and composition rules.

Do not edit generated `build/` output directly.

## Build, Test, and Development Commands

Use PNPM for all package operations.

- `pnpm build` compiles TypeScript and marks CLI outputs executable.
- `pnpm check` to run Biome linter and formatter

## Coding Style & Naming Conventions

The project uses strict TypeScript with ES modules (`NodeNext`) and `.js` import specifiers for local TypeScript files. Use tabs for indentation and double quotes for strings. Prefer feature modules (`mcp`, `bridge`, `policy`) and descriptive camelCase function names.

Use `@/` imports rooted at `src/` across directories (for example, `@/shared/errors.js`). Keep same-directory imports relative (`./model.js`). `pnpm build` rewrites aliases to relative paths for Node; plain `tsc` does not produce runnable output.


## Rules

- Never log to stdout while running as an MCP server; stdout is reserved for MCP protocol messages. Use stderr for diagnostics. CLI commands may intentionally print command results to stdout.
- Always run `pnpm check` after making changes to format and lint with Biome
