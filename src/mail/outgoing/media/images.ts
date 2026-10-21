// Validate the image container signature and dimensions without decoding or executing image contents.

type Dimensions = { width: number; height: number };

const MAX_IMAGE_SIDE = 4096;

const MAX_IMAGE_PIXELS = 16_777_216;

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const GIF_SIGNATURES = ["GIF87a", "GIF89a"];

const JPEG_START_OF_SCAN = 0xda;

const JPEG_END_OF_IMAGE = 0xd9;

// Baseline, extended sequential, and progressive frames carry the image size.
const JPEG_START_OF_FRAME_MARKERS = [0xc0, 0xc1, 0xc2];

function hasPngStructure(content: Buffer) {
	return (
		content.length >= 45 &&
		content.subarray(0, 8).equals(PNG_SIGNATURE) &&
		content.readUInt32BE(8) === 13 &&
		content.toString("ascii", 12, 16) === "IHDR" &&
		content.toString("ascii", content.length - 8, content.length - 4) === "IEND"
	);
}

function pngDimensions(content: Buffer): Dimensions | undefined {
	if (!hasPngStructure(content)) return undefined;
	return { width: content.readUInt32BE(16), height: content.readUInt32BE(20) };
}

function gifDimensions(content: Buffer): Dimensions | undefined {
	const hasGifStructure =
		content.length >= 14 &&
		GIF_SIGNATURES.includes(content.toString("ascii", 0, 6)) &&
		content[content.length - 1] === 0x3b;
	if (!hasGifStructure) return undefined;
	return { width: content.readUInt16LE(6), height: content.readUInt16LE(8) };
}

function hasJpegBoundaryMarkers(content: Buffer) {
	return (
		content.length >= 12 &&
		content[0] === 0xff &&
		content[1] === 0xd8 &&
		content[content.length - 2] === 0xff &&
		content[content.length - 1] === 0xd9
	);
}

// TEM and RSTn markers have no length field.
function isStandaloneJpegMarker(marker: number) {
	return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
}

function jpegDimensions(content: Buffer): Dimensions | undefined {
	if (!hasJpegBoundaryMarkers(content)) return undefined;

	let offset = 2;
	while (offset + 4 <= content.length) {
		if (content[offset] !== 0xff) return undefined;
		while (content[offset] === 0xff) offset += 1;

		const marker = content[offset];
		offset += 1;
		if (
			marker === undefined ||
			marker === JPEG_START_OF_SCAN ||
			marker === JPEG_END_OF_IMAGE
		)
			return undefined;
		if (isStandaloneJpegMarker(marker)) continue;

		if (offset + 2 > content.length) return undefined;
		const segmentLength = content.readUInt16BE(offset);
		if (segmentLength < 2 || offset + segmentLength > content.length)
			return undefined;

		if (JPEG_START_OF_FRAME_MARKERS.includes(marker)) {
			if (segmentLength < 8) return undefined;
			return {
				height: content.readUInt16BE(offset + 3),
				width: content.readUInt16BE(offset + 5),
			};
		}

		offset += segmentLength;
	}
	return undefined;
}

function imageDimensions(
	content: Buffer,
	contentType: string,
): Dimensions | undefined {
	switch (contentType) {
		case "image/png":
			return pngDimensions(content);
		case "image/gif":
			return gifDimensions(content);
		case "image/jpeg":
			return jpegDimensions(content);
		default:
			return undefined;
	}
}

export function validInlineImage(content: Buffer, contentType: string) {
	const dimensions = imageDimensions(content, contentType);
	if (!dimensions) return false;

	const { width, height } = dimensions;
	return (
		width > 0 &&
		height > 0 &&
		width <= MAX_IMAGE_SIDE &&
		height <= MAX_IMAGE_SIDE &&
		width * height <= MAX_IMAGE_PIXELS
	);
}
