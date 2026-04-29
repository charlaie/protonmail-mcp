import type {
	FetchMessageObject,
	ListResponse,
	MessageAddressObject,
} from "imapflow";
import type { AddressObject } from "mailparser";

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
		return addresses.map((address) => address.text).filter(Boolean).join(", ");
	}

	return addresses.text;
}

export function messageSummary(message: FetchMessageObject) {
	return {
		uid: message.uid,
		subject: message.envelope?.subject ?? "",
		from: formatAddresses(message.envelope?.from),
		to: formatAddresses(message.envelope?.to),
		cc: formatAddresses(message.envelope?.cc),
		date:
			message.envelope?.date?.toISOString() ??
			(message.internalDate instanceof Date
				? message.internalDate.toISOString()
				: message.internalDate),
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
