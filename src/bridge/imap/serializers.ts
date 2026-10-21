import type {
	FetchMessageObject,
	ListResponse,
	MessageAddressObject,
} from "imapflow";
import type { AddressObject, EmailAddress } from "mailparser";
import type { MessageSummary } from "../../mail/message.js";

type ParsedAddresses = AddressObject | AddressObject[] | undefined;

function toDate(value: unknown) {
	if (value instanceof Date) return value;
	if (typeof value === "string") return new Date(value);
	return undefined;
}

export function validDate(value: unknown): Date | undefined {
	const date = toDate(value);
	return date && Number.isFinite(date.getTime()) ? date : undefined;
}

export function messageReceivedTime(message: FetchMessageObject) {
	const received =
		validDate(message.internalDate) ?? validDate(message.envelope?.date);
	return received?.getTime() ?? 0;
}

function formatAddress({ name, address }: MessageAddressObject) {
	if (name && address) return `${name} <${address}>`;
	return address ?? name ?? "";
}

function formatAddresses(addresses?: MessageAddressObject[]): string[] {
	return (addresses ?? []).map(formatAddress).filter(Boolean);
}

function addressGroups(addresses: ParsedAddresses) {
	if (Array.isArray(addresses)) return addresses;
	return addresses ? [addresses] : [];
}

export function parsedAddressText(
	addresses: ParsedAddresses,
): string | undefined {
	if (!Array.isArray(addresses)) return addresses?.text;
	return addresses
		.map((address) => address.text)
		.filter(Boolean)
		.join(", ");
}

export function parsedAddressEmails(addresses: ParsedAddresses): string[] {
	return addressGroups(addresses).flatMap((group) =>
		addressEmails(group.value),
	);
}

function addressEmails(entries: EmailAddress[]): string[] {
	return entries.flatMap((entry) => {
		if (entry.group) return addressEmails(entry.group);
		return entry.address ? [entry.address.trim()] : [];
	});
}

function envelopeSenderEmails(message: FetchMessageObject) {
	return (message.envelope?.from ?? []).flatMap(({ address }) =>
		address ? [address.trim().toLowerCase()] : [],
	);
}

export function messageSummary(
	message: FetchMessageObject,
	uidValidity: string,
): MessageSummary {
	const date =
		validDate(message.envelope?.date) ?? validDate(message.internalDate);
	return {
		uid: message.uid,
		uidValidity,
		subject: message.envelope?.subject ?? "",
		from: formatAddresses(message.envelope?.from),
		senderEmails: envelopeSenderEmails(message),
		to: formatAddresses(message.envelope?.to),
		cc: formatAddresses(message.envelope?.cc),
		date: date?.toISOString(),
		flags: [...(message.flags ?? [])],
		size: message.size,
	};
}

export function mailboxSummary(mailbox: ListResponse) {
	return {
		path: mailbox.path,
		name: mailbox.name,
		parentPath: mailbox.parentPath,
		delimiter: mailbox.delimiter,
		specialUse: mailbox.specialUse,
		flags: [...mailbox.flags],
		listed: mailbox.listed,
		subscribed: mailbox.subscribed,
		status: mailbox.status,
	};
}
