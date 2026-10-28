import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import { UidSchema, UidValiditySchema } from "@/mail/identity.js";
import { MailError } from "@/shared/mail-error.js";

export const SEARCH_CURSOR_TTL_MS = 15 * 60 * 1000;
const PositionSchema = z.strictObject({
	time: z.number().int().min(-8_640_000_000_000_000).max(8_640_000_000_000_000),
	uid: UidSchema,
});
const CursorStateSchema = z.strictObject({
	version: z.literal(1),
	binding: z.string().regex(/^[a-f0-9]{64}$/),
	uidValidity: UidValiditySchema,
	ceiling: UidSchema,
	after: PositionSchema,
	expiresAt: z.number().int().nonnegative(),
});
export type SearchPosition = z.infer<typeof PositionSchema>;
export type SearchCursorState = z.infer<typeof CursorStateSchema>;

export function invalidSearchCursor(): never {
	throw new MailError(
		"INVALID_INPUT",
		"Search cursor is invalid, expired, or belongs to another request, policy, account or server session. Omit cursor to restart the search.",
		"refresh_identity",
	);
}

/** One ephemeral key per IMAP service. No snapshots or cursor registry survive restart. */
export function createSearchCursorCodec(now = Date.now) {
	const key = randomBytes(32);
	return {
		now,
		encode(state: SearchCursorState) {
			const iv = randomBytes(12);
			const cipher = createCipheriv("aes-256-gcm", key, iv);
			const ciphertext = Buffer.concat([
				cipher.update(JSON.stringify(state), "utf8"),
				cipher.final(),
			]);
			return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
				"base64url",
			);
		},
		decode({
			token,
			binding,
		}: {
			token: string;
			binding: string;
		}): SearchCursorState {
			try {
				if (token.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(token))
					return invalidSearchCursor();
				const bytes = Buffer.from(token, "base64url");
				if (bytes.length < 29 || bytes.toString("base64url") !== token)
					return invalidSearchCursor();
				const decipher = createDecipheriv(
					"aes-256-gcm",
					key,
					bytes.subarray(0, 12),
				);
				decipher.setAuthTag(bytes.subarray(12, 28));
				const json = Buffer.concat([
					decipher.update(bytes.subarray(28)),
					decipher.final(),
				]);
				const state = CursorStateSchema.parse(
					JSON.parse(json.toString("utf8")),
				);
				if (state.binding !== binding || state.expiresAt <= now())
					return invalidSearchCursor();
				return state;
			} catch {
				return invalidSearchCursor();
			}
		},
	};
}
export type SearchCursorCodec = ReturnType<typeof createSearchCursorCodec>;
