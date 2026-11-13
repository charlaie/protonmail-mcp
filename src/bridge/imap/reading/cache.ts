import type { GetMessageInput } from "@/mail/identity.js";
import type { MessageContent } from "@/mail/message.js";

export const MESSAGE_CACHE_LIMITS = {
	maxBytes: 8 * 1024 * 1024,
	maxEntries: 16,
	ttlMs: 60_000,
};
type Entry = { value: MessageContent; bytes: number; expires: number };

/** Per-Bridge-module LRU for immutable UID content; never stores authorization. */
export function createMessageCache(now: () => number = Date.now) {
	const entries = new Map<string, Entry>();
	let bytes = 0;
	const keyFor = (input: GetMessageInput) =>
		JSON.stringify([input.mailbox, input.uidValidity, input.uid]);
	function remove(key: string) {
		const entry = entries.get(key);
		if (entry) bytes -= entry.bytes;
		entries.delete(key);
	}
	return {
		get(input: GetMessageInput, size: number | undefined) {
			const key = keyFor(input);
			const entry = entries.get(key);
			if (!entry) return undefined;
			if (entry.expires <= now() || entry.value.size !== size) {
				remove(key);
				return undefined;
			}
			entries.delete(key);
			entries.set(key, entry);
			return structuredClone(entry.value);
		},
		set(input: GetMessageInput, value: MessageContent) {
			const key = keyFor(input);
			remove(key);
			const size = Buffer.byteLength(JSON.stringify(value));
			if (size > MESSAGE_CACHE_LIMITS.maxBytes) return;
			for (const [oldKey, entry] of entries) {
				if (entry.expires <= now()) remove(oldKey);
			}
			while (
				entries.size >= MESSAGE_CACHE_LIMITS.maxEntries ||
				bytes + size > MESSAGE_CACHE_LIMITS.maxBytes
			) {
				const oldest = entries.keys().next();
				if (oldest.done) break;
				remove(oldest.value);
			}
			entries.set(key, {
				value: structuredClone(value),
				bytes: size,
				expires: now() + MESSAGE_CACHE_LIMITS.ttlMs,
			});
			bytes += size;
		},
	};
}
export type MessageCache = ReturnType<typeof createMessageCache>;
