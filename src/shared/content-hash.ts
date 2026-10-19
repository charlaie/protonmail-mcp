import { createHash } from "node:crypto";

export function hashContent(value: unknown) {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
