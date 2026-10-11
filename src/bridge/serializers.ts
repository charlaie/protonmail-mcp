import type {
	FetchMessageObject,
	ListResponse,
	MessageAddressObject,
} from "imapflow";
import type { AddressObject, EmailAddress } from "mailparser";

export function validDate(value: unknown): Date | undefined {
	const date =
		value instanceof Date
			? value
			: typeof value === "string"
				? new Date(value)
				: undefined;
	return date && Number.isFinite(date.getTime()) ? date : undefined;
}

export function messageReceivedTime(message: FetchMessageObject) {
	return (
		(
			validDate(message.internalDate) ?? validDate(message.envelope?.date)
		)?.getTime() ?? 0
	);
}

function formatAddresses(addresses?: MessageAddressObject[]): string[] {
	return (
		addresses?.map(({ name, address }) =>
			name && address ? `${name} <${address}>` : (address ?? name ?? ""),
		) ?? []
	).filter(Boolean);
}

export function parsedAddressText(
	addresses: AddressObject | AddressObject[] | undefined,
): string | undefined {
	if (!addresses) {
		return undefined;
	}

	if (Array.isArray(addresses)) {
		return addresses
			.map((address) => address.text)
			.filter(Boolean)
			.join(", ");
	}

	return addresses.text;
}

export function parsedAddressEmails(
	addresses: AddressObject | AddressObject[] | undefined,
): string[] {
	return (
		Array.isArray(addresses) ? addresses : addresses ? [addresses] : []
	).flatMap((group) => addressEmails(group.value));
}

function addressEmails(entries: EmailAddress[]): string[] {
	return entries.flatMap((entry) =>
		entry.group
			? addressEmails(entry.group)
			: entry.address
				? [entry.address.trim()]
				: [],
	);
}

import type { MessageSummary } from "./message-model.js";

export type { MessageSummary } from "./message-model.js";

export function messageSummary(
	message: FetchMessageObject,
	uidValidity: string,
): MessageSummary {
	return {
		uid: message.uid,
		uidValidity,
		subject: message.envelope?.subject ?? "",
		from: formatAddresses(message.envelope?.from),
		senderEmails: (message.envelope?.from ?? []).flatMap(({ address }) =>
			address ? [address.trim().toLowerCase()] : [],
		),
		to: formatAddresses(message.envelope?.to),
		cc: formatAddresses(message.envelope?.cc),
		date: (
			validDate(message.envelope?.date) ?? validDate(message.internalDate)
		)?.toISOString(),
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
