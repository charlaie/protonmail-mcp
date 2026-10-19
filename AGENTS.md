# Repository Guidelines

## Project Structure & Module Organization

This is a TypeScript MCP server for Proton Mail via Proton Bridge. Source lives in `src/` and compiles to `build/`.

- `src/index.ts` is the CLI entry point and MCP stdio startup.
- `src/mcp/` contains MCP server setup, schemas, responses, and elicitation helpers.
- `src/bridge/` contains Proton Bridge configuration, IMAP reads, sessions, and SMTP submission.
- `src/mail/` owns physical message identity, parsed message contracts, and policy-authorized mail access.
- `src/drafts/` owns draft requests, composition, snapshots, and draft lifecycle logic.
- `src/sending/` owns send requests, delivery outcomes, and send lifecycle logic.
- `src/outgoing/` owns message composition contracts, sender selection, and outgoing media.
- `src/attachments/` owns incoming attachment inspection, downloads, and format limits.
- `src/inbox/` owns inbox actions, mailbox creation, and inbox lifecycle logic.
- `src/operations/` owns the SQLite journal, message claims, and logical draft identity bindings.
- `src/policy/` contains read-policy schema, storage, enforcement, CLI, and checks.
- `src/shared/` contains cross-cutting helpers such as error formatting.

Do not edit generated `build/` output directly.

## Build, Test, and Development Commands

Use PNPM for all package operations.

- `pnpm build` compiles TypeScript and marks CLI outputs executable.
- `pnpm check` to run Biome linter and formatter

## Coding Style & Naming Conventions

The project uses strict TypeScript with ES modules (`NodeNext`) and `.js` import specifiers for local TypeScript files. Use tabs for indentation and double quotes for strings. Prefer feature modules (`mcp`, `bridge`, `policy`) and descriptive camelCase function names.


## Rules

- Never log to stdout while running as an MCP server; stdout is reserved for MCP protocol messages. Use stderr for diagnostics. CLI commands may intentionally print command results to stdout.
- Always run `pnpm check` after making changes to format and lint with Biome