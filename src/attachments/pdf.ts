import { copyFile, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ExtractionContext } from "./inspect.js";
import {
	MAX_ATTACHMENT_CHARACTERS,
	MAX_PDF_BYTES,
	MAX_PDF_PAGES,
} from "./limits.js";
import { runPdfSandbox } from "./sandbox.js";

export const PdfResultSchema = z.discriminatedUnion("status", [
	z
		.object({
			status: z.literal("ok"),
			text: z.string().max(MAX_ATTACHMENT_CHARACTERS),
			truncated: z.boolean(),
			pages: z.number().int().min(1).max(MAX_PDF_PAGES),
			pagesRead: z.number().int().min(1).max(MAX_PDF_PAGES),
		})
		.strict(),
	z
		.object({
			status: z.literal("ocr_required"),
			pages: z.number().int().min(1).max(MAX_PDF_PAGES),
		})
		.strict(),
	z
		.object({
			status: z.literal("error"),
			reason: z.enum(["encrypted", "malformed", "page_limit", "input_limit"]),
		})
		.strict(),
]);
export type PdfResult = z.infer<typeof PdfResultSchema>;

let extractionInProgress = false;

export async function extractPdf(bytes: Buffer, context: ExtractionContext) {
	if (extractionInProgress)
		throw new Error(
			"Another PDF is being inspected. Retry after it completes.",
		);
	extractionInProgress = true;
	try {
		return await extractInSandbox(bytes, context);
	} finally {
		extractionInProgress = false;
	}
}

async function extractInSandbox(bytes: Buffer, context: ExtractionContext) {
	if (bytes.length > MAX_PDF_BYTES)
		throw new Error("PDF exceeds the 5 MiB limit.");
	const directory = await mkdtemp(join(tmpdir(), "protonmail-pdf-"));
	try {
		const packageRoot = dirname(
			fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")),
		);
		const parserDirectory = join(
			directory,
			"node_modules",
			"pdfjs-dist",
			"legacy",
			"build",
		);
		await mkdir(parserDirectory, { recursive: true });
		await writeFile(join(directory, "package.json"), '{"type":"module"}', {
			mode: 0o600,
		});
		await writeFile(
			join(directory, "node_modules", "pdfjs-dist", "package.json"),
			'{"type":"module"}',
			{ mode: 0o600 },
		);
		await copyFile(
			fileURLToPath(new URL("./pdf-worker.js", import.meta.url)),
			join(directory, "pdf-worker.js"),
		);
		await copyFile(
			fileURLToPath(new URL("./limits.js", import.meta.url)),
			join(directory, "limits.js"),
		);
		await copyFile(
			fileURLToPath(new URL("./text-budget.js", import.meta.url)),
			join(directory, "text-budget.js"),
		);
		for (const name of ["pdf.mjs", "pdf.worker.mjs"])
			await copyFile(
				join(packageRoot, "legacy", "build", name),
				join(parserDirectory, name),
			);
		for (const name of ["cmaps", "standard_fonts"])
			await cp(join(packageRoot, name), join(directory, name), {
				recursive: true,
			});
		const result = PdfResultSchema.parse(
			JSON.parse(
				(
					await runPdfSandbox({
						directory,
						input: bytes,
						protectedFiles: context.protectedFiles,
					})
				).toString("utf8"),
			),
		);
		if (result.status === "error") {
			const reasons = {
				encrypted: "Password-protected PDFs cannot be inspected.",
				malformed: "PDF is malformed or cannot be safely parsed.",
				page_limit: "PDF exceeds the 50 page inspection limit.",
				input_limit: "PDF exceeds the 5 MiB inspection limit.",
			};
			throw new Error(reasons[result.reason]);
		}
		return result.status === "ocr_required"
			? {
					...result,
					reason:
						"PDF contains no extractable text. It may be scanned and require OCR, which this tool does not perform.",
				}
			: result;
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
