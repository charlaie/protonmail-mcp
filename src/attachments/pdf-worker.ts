// This entry point runs only in the OS sandbox, never in the MCP process.
import {
	getDocument,
	PasswordException,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import { MAX_PDF_BYTES, MAX_PDF_PAGES } from "./limits.js";
import type { PdfResult } from "./pdf.js";
import { createTextBudget } from "./text-budget.js";

// PDF.js can emit diagnostics through console.log. Keep stdout as a bounded
// JSON result channel captured by the parent, independent of MCP stdio.
console.log = (...values: unknown[]) => console.error(...values);

async function inspect(): Promise<PdfResult> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of process.stdin) {
		if (!Buffer.isBuffer(chunk))
			return { status: "error", reason: "malformed" };
		size += chunk.length;
		if (size > MAX_PDF_BYTES) return { status: "error", reason: "input_limit" };
		chunks.push(chunk);
	}
	const loading = getDocument({
		data: new Uint8Array(Buffer.concat(chunks, size)),
		verbosity: 0,
		stopAtErrors: true,
		disableFontFace: true,
		useSystemFonts: false,
		isOffscreenCanvasSupported: false,
		isImageDecoderSupported: false,
		useWasm: false,
		useWorkerFetch: false,
		cMapUrl: `${process.cwd()}/cmaps/`,
		cMapPacked: true,
		standardFontDataUrl: `${process.cwd()}/standard_fonts/`,
	});
	try {
		const document = await loading.promise;
		if (document.numPages > MAX_PDF_PAGES)
			return { status: "error", reason: "page_limit" };
		const output = createTextBudget();
		let pagesRead = 0;
		for (let number = 1; number <= document.numPages; number++) {
			if (number > 1 && output.append("\n")) break;
			const page = await document.getPage(number);
			pagesRead = number;
			let limitReached = false;
			try {
				const content = await page.getTextContent();
				for (const item of content.items) {
					if (!("str" in item)) continue;
					const value = item.str + (item.hasEOL ? "\n" : " ");
					if (output.append(value)) {
						limitReached = true;
						break;
					}
				}
			} finally {
				page.cleanup();
			}
			if (limitReached) break;
		}
		const { text, truncated } = output.result();
		if (!text.trim())
			return { status: "ocr_required", pages: document.numPages };
		return {
			status: "ok",
			text,
			truncated: truncated || pagesRead < document.numPages,
			pages: document.numPages,
			pagesRead,
		};
	} catch (error) {
		return {
			status: "error",
			reason: error instanceof PasswordException ? "encrypted" : "malformed",
		};
	} finally {
		await loading.destroy();
	}
}

try {
	process.stdout.write(JSON.stringify(await inspect()));
} catch {
	process.stdout.write(
		JSON.stringify({
			status: "error",
			reason: "malformed",
		} satisfies PdfResult),
	);
}
