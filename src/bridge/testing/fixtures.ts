import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type {
	FetchMessageObject,
	FetchQueryObject,
	SearchObject,
} from "imapflow";
import type { BridgeConfig } from "@/bridge/config.js";
import type { ImapClient } from "@/bridge/imap/session.js";

export const testConfig: BridgeConfig = {
	user: "bridge@example.com",
	password: "fixture-password",
	host: "127.0.0.1",
	imapPort: 1143,
	smtpPort: 1025,
	tlsRejectUnauthorized: false,
	ownAddresses: ["bridge@example.com"],
};

export function fixtureMessage(
	uid: number,
	options: {
		sender?: string;
		id?: string;
		references?: string[];
		text?: string;
	} = {},
): FetchMessageObject {
	const sender = options.sender ?? "trusted@example.com";
	const id = options.id ?? `<message-${uid}@example.com>`;
	const references = (options.references ?? []).map(
		(reference) => `References: ${reference}`,
	);
	const headers = [
		`From: ${sender}`,
		`Message-ID: ${id}`,
		...references,
		"Content-Type: text/plain; charset=utf-8",
	].join("\r\n");
	const source = Buffer.from(
		`${headers}\r\n\r\n${options.text ?? `Body ${uid}`}`,
	);
	return {
		uid,
		seq: uid,
		size: source.length,
		internalDate: new Date(uid * 1000),
		flags: new Set(["\\Draft"]),
		envelope: { from: [{ address: sender }], messageId: id },
		headers: Buffer.from(`${headers}\r\n\r\n`),
		source,
	};
}

function uidsFromRange(range: Parameters<ImapClient["fetchAll"]>[0]) {
	if (Array.isArray(range)) return range;
	if (typeof range === "number") return [range];
	if (typeof range === "string") return range.split(",").map(Number);
	throw new Error("Unexpected fixture fetch range.");
}

const SPECIAL_USE = new Map([
	["Drafts", "\\Drafts"],
	["Sent", "\\Sent"],
]);

const NAMESPACES = ["Folders", "Labels"];

type FixtureAttachment = {
	content: Buffer;
	meta: {
		filename: string;
		contentType: string;
		charset?: string;
		disposition?: string;
	};
};

// Only the external IMAP boundary is simulated. MIME parsing and policy logic stay real.
export class FakeImap extends EventEmitter implements ImapClient {
	capabilities = new Map<string, boolean>([["UIDPLUS", true]]);
	permanentFlags = new Set(["\\Seen", "\\Flagged"]);
	uidValidity = 7n;
	selected = "INBOX";
	mailboxes = new Map<string, FetchMessageObject[]>([["INBOX", []]]);
	attachmentContents = new Map<string, FixtureAttachment>();

	connectFailure = false;
	searchFailure = false;
	deleteFailure: "none" | "false" | "throw" | "event" = "none";

	closed = false;
	loggedOut = false;
	searches: SearchObject[] = [];
	sourceFetches = 0;
	fetchBatchSizes: number[] = [];
	downloads: {
		uid: string;
		part: string | undefined;
		maxBytes: number | undefined;
	}[] = [];
	appends: { content: string | Buffer; flags: string[] }[] = [];
	deletions = 0;
	flagChanges: { uid: number; flag: string; enabled: boolean }[] = [];
	moves: { uid: number; source: string; destination: string }[] = [];
	mailboxCreations: string[] = [];

	async connect() {
		if (this.connectFailure) throw new Error("Authentication failed");
	}

	async logout() {
		this.loggedOut = true;
	}

	close() {
		this.closed = true;
	}

	async list() {
		return [...this.mailboxes.keys()].map((path) => {
			const specialUse = SPECIAL_USE.get(path);
			return {
				path,
				pathAsListed: path,
				parent: [],
				parentPath: "",
				name: path,
				delimiter: "/",
				flags: new Set<string>(NAMESPACES.includes(path) ? ["\\Noselect"] : []),
				listed: true,
				subscribed: true,
				...(specialUse ? { specialUse } : {}),
			};
		});
	}

	async mailboxCreate(path: string | string[]) {
		if (typeof path !== "string") throw new Error("Expected a mailbox path");
		this.mailboxCreations.push(path);
		const created = !this.mailboxes.has(path);
		if (created) this.mailboxes.set(path, []);
		return { path, created };
	}

	async mailboxOpen(path: string | string[]) {
		if (typeof path !== "string")
			throw new Error("Unexpected fixture mailbox path");
		this.selected = path;
		return {
			path,
			delimiter: "/",
			flags: new Set<string>(),
			uidValidity: this.uidValidity,
			permanentFlags: this.permanentFlags,
			uidNext: this.currentMessages().reduce(
				(next, message) => Math.max(next, message.uid + 1),
				100,
			),
			exists: this.currentMessages().length,
		};
	}

	async search(query: SearchObject) {
		this.searches.push(query);
		if (this.searchFailure) return false;
		// Return all hits, including substring matches, to exercise exact-ID validation.
		return this.currentMessages().map((message) => message.uid);
	}

	async fetchAll(
		range: Parameters<ImapClient["fetchAll"]>[0],
		query: FetchQueryObject,
	) {
		const uids = uidsFromRange(range);
		this.fetchBatchSizes.push(uids.length);
		return this.currentMessages()
			.filter((message) => uids.includes(message.uid))
			.map((message) => this.fetched(message, query));
	}

	async fetchOne(
		range: Parameters<ImapClient["fetchOne"]>[0],
		query: FetchQueryObject,
	) {
		const [uid] = uidsFromRange(range);
		const message = uid === undefined ? undefined : this.findMessage(uid);
		return message ? this.fetched(message, query) : false;
	}

	async download(
		uid: string,
		part?: string,
		options?: { uid?: boolean; maxBytes?: number; chunkSize?: number },
	) {
		this.downloads.push({ uid, part, maxBytes: options?.maxBytes });
		const attachment = this.attachmentContents.get(
			`${this.selected}:${uid}:${part}`,
		);
		if (!attachment) throw new Error("Fixture attachment was not found.");
		return {
			meta: { ...attachment.meta, expectedSize: attachment.content.length },
			content: Readable.from([
				attachment.content.subarray(0, options?.maxBytes),
			]),
		};
	}

	async append(path: string, content: string | Buffer, flags: string[] = []) {
		this.appends.push({ content, flags });
		const uid = 98 + this.appends.length;
		const saved = fixtureMessage(uid);
		saved.source = Buffer.isBuffer(content) ? content : Buffer.from(content);
		saved.size = saved.source.length;
		saved.headers = Buffer.from(
			saved.source.toString().split("\r\n\r\n")[0] ?? "",
		);
		saved.flags = new Set(flags);
		this.mailboxes.set(path, [...(this.mailboxes.get(path) ?? []), saved]);
		return {
			destination: path,
			uid,
			uidValidity: this.uidValidity,
			seq: uid,
		};
	}

	async messageDelete(range: Parameters<ImapClient["messageDelete"]>[0]) {
		this.deletions++;
		if (this.deleteFailure === "event") {
			const error = new Error("Socket failed during deletion");
			this.emit("error", error);
			throw error;
		}
		if (this.deleteFailure === "throw") throw new Error("STORE failed");
		if (this.deleteFailure === "false") return false;

		const removed = uidsFromRange(range);
		this.setCurrentMessages(
			this.currentMessages().filter(
				(message) => !removed.includes(message.uid),
			),
		);
		return true;
	}

	async messageFlagsAdd(
		range: Parameters<ImapClient["messageFlagsAdd"]>[0],
		flags: string[],
	) {
		for (const uid of uidsFromRange(range)) {
			const message = this.findMessage(uid);
			if (!message) return false;
			message.flags ??= new Set();
			for (const flag of flags) {
				message.flags.add(flag);
				this.flagChanges.push({ uid, flag, enabled: true });
			}
		}
		return true;
	}

	async messageFlagsRemove(
		range: Parameters<ImapClient["messageFlagsRemove"]>[0],
		flags: string[],
	) {
		for (const uid of uidsFromRange(range)) {
			const message = this.findMessage(uid);
			if (!message) return false;
			for (const flag of flags) {
				message.flags?.delete(flag);
				this.flagChanges.push({ uid, flag, enabled: false });
			}
		}
		return true;
	}

	async messageMove(
		range: Parameters<ImapClient["messageMove"]>[0],
		destination: string,
	) {
		const source = this.selected;
		const uidMap = new Map<number, number>();
		for (const uid of uidsFromRange(range)) {
			const message = this.findMessage(uid);
			if (!message) return false;

			const movedUid = 200 + this.moves.length;
			this.mailboxes.set(destination, [
				...(this.mailboxes.get(destination) ?? []),
				{ ...message, uid: movedUid, flags: new Set(message.flags) },
			]);
			// Labels are additive in Bridge, so the source copy remains.
			if (!destination.startsWith("Labels/"))
				this.setCurrentMessages(
					this.currentMessages().filter((other) => other.uid !== uid),
				);
			this.moves.push({ uid, source, destination });
			uidMap.set(uid, movedUid);
		}
		return { path: source, destination, uidValidity: this.uidValidity, uidMap };
	}

	private currentMessages() {
		return this.mailboxes.get(this.selected) ?? [];
	}

	private setCurrentMessages(messages: FetchMessageObject[]) {
		this.mailboxes.set(this.selected, messages);
	}

	private findMessage(uid: number) {
		return this.currentMessages().find((message) => message.uid === uid);
	}

	private fetched(message: FetchMessageObject, query: FetchQueryObject) {
		if (query.source) this.sourceFetches++;
		return {
			...message,
			source: query.source ? message.source : undefined,
			headers: query.headers ? message.headers : undefined,
		};
	}
}
