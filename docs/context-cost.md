# Measuring context cost

Run `pnpm measure:tools` to build the server and measure the real `tools/list` response with all grants, read-only grants, and search/message-read grants. The fixture uses an isolated temporary account and policy and never contacts Bridge. It removes its files afterward. The command reports tool count, complete catalog bytes, input-definition bytes, and output-schema bytes. The test fails if a catalog exceeds 256,000 bytes or the function input definitions exceed 64,000 bytes.

Input-definition bytes serialize names, descriptions and input schemas into function definitions. Catalog bytes also include output schemas, annotations and other MCP fields. These are reproducible protocol measurements, not token counts or billing estimates. The test retains output schemas for validation and interoperability.

## Verify the host before optimizing schemas

An MCP server cannot observe how its host converts tools into provider requests. In particular, `tools/list` does not tell us whether the host forwards output schemas, eagerly loads every tool, defers discovery, or sends both JSON text and structured content to the model. The host must expose its outgoing request or provider usage to establish those facts. This workspace’s tools do not provide that request payload or a controlled provider token counter, so this change makes no claim about actual host input-token overhead.

For a target host:

1. Use a temporary policy granting only the tools needed for a representative read task. Avoid mail-changing tasks when measuring discovery and output overhead.
2. Inspect the host’s provider-request diagnostics to establish which tool fields and result representations it actually sends. Keep diagnostics private; real message content can appear in them.
3. Compare provider-reported input usage for the same model, provider, prompt and conversation with and without those definitions. Keep tool discovery and caching settings identical. Separately measure the same conversation before and after a representative result.
4. Record task success, request count, total input usage, cached input usage where available, and billed cost. Smaller individual results may require more calls to complete a task.

Do not remove output validation solely because output schemas dominate the catalog’s wire bytes. If the host excludes those fields from model requests, removing them saves no model context. If schemas are forwarded, narrow grants or deferred discovery can avoid loading unrelated operations while retaining their typed contracts.

## Defaults and caller migration

Search and thread defaults return 10 entries. Threads omit bodies unless `includeText` is true. Message and draft body reads return pages; callers must follow `textPage.nextOffset` before treating a body as complete. Draft continuation requires `expectedRevision` from the first page. Metadata lists now return pages with `nextOffset`. Batches return first body pages with capped metadata, and expose continuation per found item. Message views no longer duplicate raw header/address blocks.

These are intentional caller-visible changes. Update clients that assumed a complete body or list in one call. A thread with `discoveryComplete: false` is a partial reconstruction even if `limitReached` is false.
