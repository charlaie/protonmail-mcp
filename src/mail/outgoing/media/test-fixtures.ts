import type { AttachmentPayload, InlineImagePayload } from "./model.js";
export const testImage: InlineImagePayload = {
	filename: "image.png",
	contentType: "image/png",
	contentBase64:
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCWkAAAAASUVORK5CYII=",
	alt: 'A < & "logo"',
};
export const testFile: AttachmentPayload = {
	filename: "report.pdf",
	contentType: "application/pdf",
	contentBase64: Buffer.from(
		"%PDF-1.7\nBinary bytes \0\xff",
		"latin1",
	).toString("base64"),
};
// One pixel, baseline grayscale JPEG with a zero DCT block and minimal Huffman tables.
export const testJpeg: InlineImagePayload = {
	filename: "pixel.jpg",
	contentType: "image/jpeg",
	alt: "One gray pixel",
	contentBase64:
		"/9j/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AP//Z",
};
export const testGif: InlineImagePayload = {
	filename: "pixel.gif",
	contentType: "image/gif",
	alt: "One transparent pixel",
	contentBase64: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
};
