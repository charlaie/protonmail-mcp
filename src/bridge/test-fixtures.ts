import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type {
	FetchMessageObject,
	FetchQueryObject,
	SearchObject,
} from "imapflow";
import type { BridgeConfig } from "./config.js";
import type { ImapClient } from "./session.js";

export const testConfig: BridgeConfig = {
	user: "bridge@example.com",
	password: "fixture-password",
	host: "127.0.0.1",
	imapPort: 1143,
	smtpPort: 1025,
	tlsRejectUnauthorized: false,
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
	const id = options.id ?? `<message-${uid}@example.com>`;
	const headers = [
		`From: ${options.sender ?? "trusted@example.com"}`,
		`Message-ID: ${id}`,
		...(options.references?.map((reference) => `References: ${reference}`) ??
			[]),
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
		envelope: {
			from: [{ address: options.sender ?? "trusted@example.com" }],
			messageId: id,
		},
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

// Only the external IMAP boundary is simulated. MIME parsing and policy logic stay real.
export class FakeImap extends EventEmitter implements ImapClient {
	capabilities = new Map<string, boolean>([["UIDPLUS", true]]);
	selected = "INBOX";
	uidValidity = 7n;
	mailboxes = new Map<string, FetchMessageObject[]>([["INBOX", []]]);
	searchFailure = false;
	searches: SearchObject[] = [];
	sourceFetches = 0;
	downloads: {
		uid: string;
		part: string | undefined;
		maxBytes: number | undefined;
	}[] = [];
	attachmentContents = new Map<
		string,
		{
			content: Buffer;
			meta: { filename: string; contentType: string; charset?: string };
		}
	>();
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
	fetchBatchSizes: number[] = [];
	appends: { content: string | Buffer; flags: string[] }[] = [];
	deleteFailure: "none" | "false" | "throw" | "event" = "none";
	deletions = 0;
	connectFailure = false;
	closed = false;
	loggedOut = false;
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
		return [];
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
			uidNext: 100,
			exists: this.currentMessages().length,
		};
	}
	private currentMessages() {
		return this.mailboxes.get(this.selected) ?? [];
	}
	async search(query: SearchObject) {
		this.searches.push(query);
		if (this.searchFailure) return false;
		// Return all hits, including substring matches, to exercise exact-ID validation.
		return this.currentMessages().map((message) => message.uid);
	}
	private fetched(message: FetchMessageObject, query: FetchQueryObject) {
		if (query.source) this.sourceFetches++;
		return {
			...message,
			source: query.source ? message.source : undefined,
			headers: query.headers ? message.headers : undefined,
		};
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
		const message = this.currentMessages().find(
			(candidate) => candidate.uid === uid,
		);
		return message ? this.fetched(message, query) : false;
	}
	async append(path: string, content: string | Buffer, flags: string[] = []) {
		this.appends.push({ content, flags });
		return {
			destination: path,
			uid: 99,
			uidValidity: this.uidValidity,
			seq: 99,
		};
	}
	async messageDelete() {
		this.deletions++;
		if (this.deleteFailure === "event") {
			const error = new Error("Socket failed during deletion");
			this.emit("error", error);
			throw error;
		}
		if (this.deleteFailure === "throw") throw new Error("STORE failed");
		return this.deleteFailure !== "false";
	}
}
