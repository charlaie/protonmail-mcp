import type { ToolAnnotations } from "@modelcontextprotocol/server";

export const READ_ONLY_TOOL = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: true,
} satisfies ToolAnnotations;

export const ADDITIVE_WRITE_TOOL = {
	...READ_ONLY_TOOL,
	readOnlyHint: false,
} satisfies ToolAnnotations;

export const DESTRUCTIVE_WRITE_TOOL = {
	...ADDITIVE_WRITE_TOOL,
	destructiveHint: true,
} satisfies ToolAnnotations;
