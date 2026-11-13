import { z } from "zod";
import { MailError } from "@/shared/mail-error.js";

export const ListPageSchema = z.object({
	limit: z.number().int().min(1).max(100).default(20),
	offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
});
export const NextOffsetSchema = z.number().int().nonnegative().nullable();

/** Pages live metadata without shortening identifiers needed by later calls. */
export function listPage<Item>(
	items: Item[],
	page: z.infer<typeof ListPageSchema>,
) {
	const selected: Item[] = [];
	for (const item of items.slice(page.offset, page.offset + page.limit)) {
		selected.push(item);
		if (Buffer.byteLength(JSON.stringify(selected)) > 64 * 1024) {
			selected.pop();
			if (selected.length === 0) {
				throw new MailError(
					"UNSUPPORTED_CONTENT",
					"One metadata entry exceeds the 64 KiB list page budget. Inspect it in Proton Mail.",
					"never",
				);
			}
			break;
		}
	}
	const next = page.offset + selected.length;
	return { items: selected, nextOffset: next < items.length ? next : null };
}
