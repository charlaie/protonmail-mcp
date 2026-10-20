// Validate the image container signature and dimensions without decoding or executing image contents.
export function validInlineImage(content: Buffer, contentType: string) {
	let width = 0;
	let height = 0;
	if (contentType === "image/png") {
		if (
			content.length < 45 ||
			!content
				.subarray(0, 8)
				.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
			content.readUInt32BE(8) !== 13 ||
			content.toString("ascii", 12, 16) !== "IHDR" ||
			content.toString("ascii", content.length - 8, content.length - 4) !==
				"IEND"
		)
			return false;
		width = content.readUInt32BE(16);
		height = content.readUInt32BE(20);
	} else if (contentType === "image/gif") {
		if (
			content.length < 14 ||
			!["GIF87a", "GIF89a"].includes(content.toString("ascii", 0, 6)) ||
			content[content.length - 1] !== 0x3b
		)
			return false;
		width = content.readUInt16LE(6);
		height = content.readUInt16LE(8);
	} else if (contentType === "image/jpeg") {
		if (
			content.length < 12 ||
			content[0] !== 0xff ||
			content[1] !== 0xd8 ||
			content[content.length - 2] !== 0xff ||
			content[content.length - 1] !== 0xd9
		)
			return false;
		let offset = 2;
		while (offset + 4 <= content.length) {
			if (content[offset] !== 0xff) return false;
			while (content[offset] === 0xff) offset++;
			const marker = content[offset++];
			if (marker === undefined || marker === 0xda || marker === 0xd9) break;
			if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
			if (offset + 2 > content.length) return false;
			const length = content.readUInt16BE(offset);
			if (length < 2 || offset + length > content.length) return false;
			if ([0xc0, 0xc1, 0xc2].includes(marker)) {
				if (length < 8) return false;
				height = content.readUInt16BE(offset + 3);
				width = content.readUInt16BE(offset + 5);
				break;
			}
			offset += length;
		}
	} else return false;
	return (
		width > 0 &&
		height > 0 &&
		width <= 4096 &&
		height <= 4096 &&
		width * height <= 16_777_216
	);
}
