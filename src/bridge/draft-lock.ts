import { MailError } from "../shared/mail-error.js";
import type { BridgeConfig } from "./config.js";
import type { editDraft } from "./drafts.js";
import type { GetMessageInput } from "./schemas.js";

type EditResult = Awaited<ReturnType<typeof editDraft>>;
type Replacement = Extract<
	EditResult,
	{ status: "replacement_created_old_delete_failed" }
>;
const pending = new Map<string, Promise<void>>();
const unresolved = new Map<string, Replacement | MailError>();

function keyFor(config: BridgeConfig, identity: GetMessageInput) {
	return JSON.stringify([
		config.host,
		config.user,
		identity.mailbox,
		identity.uidValidity,
		identity.uid,
	]);
}

// Shared across connections and server instances within this process.
async function underLock<T>(
	key: string,
	operation: () => Promise<T>,
): Promise<T> {
	const previous = pending.get(key) ?? Promise.resolve();
	let release = () => {};
	const finished = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tail = previous.then(() => finished);
	pending.set(key, tail);
	await previous;
	try {
		return await operation();
	} finally {
		release();
		if (pending.get(key) === tail) pending.delete(key);
	}
}

export function withDraftMutation<T>(
	config: BridgeConfig,
	identity: GetMessageInput,
	operation: () => Promise<T>,
) {
	const key = keyFor(config, identity);
	return underLock(key, async () => {
		const blocked = unresolved.get(key);
		if (blocked instanceof MailError) throw blocked;
		if (blocked)
			throw new MailError(
				"OPERATION_CONFLICT",
				`Original draft has an unresolved replacement UID ${blocked.newUid ?? "unknown"}, Message-ID ${blocked.messageId}. Inspect both drafts and use the chosen draft's current identity.`,
				"reconcile",
			);
		return operation();
	});
}

// A saved or uncertain replacement retires the original identity. Queued edits
// return its recovery details instead of creating more replacements.
export function withDraftEdit(
	config: BridgeConfig,
	identity: GetMessageInput,
	operation: () => Promise<EditResult>,
) {
	const key = keyFor(config, identity);
	return underLock(key, async () => {
		const blocked = unresolved.get(key);
		if (blocked instanceof MailError) throw blocked;
		if (blocked) return blocked;
		try {
			const result = await operation();
			if (result.status === "replacement_created_old_delete_failed")
				unresolved.set(key, result);
			return result;
		} catch (error) {
			if (error instanceof MailError && error.retry === "reconcile")
				unresolved.set(key, error);
			throw error;
		}
	});
}
