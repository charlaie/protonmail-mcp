import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { extractPdf } from "./pdf.js";
import { runPdfSandbox } from "./sandbox.js";

function pdfFixture(
	text: string | readonly string[] = "Invoice total 42",
	pages = 1,
	encrypted = false,
	fontSize = 12,
) {
	if (Array.isArray(text)) pages = text.length;
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	const pageIds: number[] = [];
	for (let page = 0; page < pages; page++) {
		pageIds.push(objects.length + 1);
		objects.push(
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length + 2} 0 R >>`,
		);
		const pageText = typeof text === "string" ? text : text[page];
		const stream = pageText
			? `BT /F1 ${fontSize} Tf 50 700 Td (${pageText}) Tj ET`
			: "";
		objects.push(
			`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
		);
	}
	objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages} >>`;
	if (encrypted)
		objects.push(
			`<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${"00".repeat(32)}> /U <${"00".repeat(32)}> /P -4 >>`,
		);
	let contents = "%PDF-1.4\n";
	const offsets = [0];
	for (const [index, object] of objects.entries()) {
		offsets.push(Buffer.byteLength(contents));
		contents += `${index + 1} 0 obj\n${object}\nendobj\n`;
	}
	const xref = Buffer.byteLength(contents);
	contents += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
		.slice(1)
		.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
		.join(
			"",
		)}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${encrypted ? `/Encrypt ${objects.length} 0 R /ID [<0123456789abcdef0123456789abcdef><0123456789abcdef0123456789abcdef>]` : ""} >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(contents);
}

test("PDF text extraction, OCR reporting, invalid/encrypted input, page and output limits", {
	skip: process.platform !== "darwin",
	timeout: 30_000,
}, async () => {
	const result = await extractPdf(pdfFixture(), { protectedFiles: [] });
	assert.equal(result.status, "ok");
	if (result.status !== "ok") return;
	assert.match(result.text, /Invoice total 42/);
	assert.equal(result.truncated, false);
	assert.equal(result.pages, 1);
	const ongoing = extractPdf(pdfFixture(), { protectedFiles: [] });
	await assert.rejects(
		extractPdf(pdfFixture(), { protectedFiles: [] }),
		/Another PDF/,
	);
	await ongoing;
	assert.equal(
		(await extractPdf(pdfFixture(""), { protectedFiles: [] })).status,
		"ocr_required",
	);
	await assert.rejects(
		extractPdf(Buffer.from("%PDF-1.4\ngarbage"), { protectedFiles: [] }),
		/malformed/,
	);
	await assert.rejects(
		extractPdf(pdfFixture("secret", 1, true), { protectedFiles: [] }),
		/Password-protected/,
	);
	await assert.rejects(
		extractPdf(pdfFixture("pages", 51), { protectedFiles: [] }),
		/50 page/,
	);
	const long = await extractPdf(
		pdfFixture("A".repeat(110_000), 1, false, 0.001),
		{ protectedFiles: [] },
	);
	assert.equal(long.status, "ok");
	if (long.status === "ok") {
		assert.equal(long.text.length, 100_000);
		assert.equal(long.truncated, true);
	}
	const trailingBlankPages = await extractPdf(
		pdfFixture(["A".repeat(99_998), "", ""], 1, false, 0.001),
		{ protectedFiles: [] },
	);
	assert.equal(trailingBlankPages.status, "ok");
	if (trailingBlankPages.status === "ok") {
		assert.equal(trailingBlankPages.text.length, 100_000);
		assert.equal(trailingBlankPages.truncated, true);
		assert.equal(trailingBlankPages.pages, 3);
	}
});

async function sandboxFixture(code: string) {
	const directory = await mkdtemp(join(tmpdir(), "protonmail-sandbox-test-"));
	await writeFile(join(directory, "pdf-worker.js"), code);
	return directory;
}

test("PDF OS sandbox denies unrelated files, writes, networking, process creation, and dynamic code", {
	skip: process.platform !== "darwin",
	timeout: 15_000,
}, async (t) => {
	const secrets = await mkdtemp(join(tmpdir(), "protonmail-secret-test-"));
	const secret = join(secrets, "policy.json");
	await writeFile(secret, "fixture secret");
	const directory = await sandboxFixture(`
	const fs = require('node:fs');
	const { spawnSync } = require('node:child_process');
	const net = require('node:net');
	const result = {};
	try { fs.readFileSync(${JSON.stringify(secret)}); result.read = true; } catch { result.read = false; }
	try { fs.readFileSync(__dirname + '/policy.json'); result.policy = true; } catch { result.policy = false; }
	try { fs.writeFileSync(${JSON.stringify(join(secrets, "written"))}, 'bad'); result.write = true; } catch { result.write = false; }
	result.fork = !spawnSync(process.execPath, ['-e', 'process.exit(0)']).error;
	try { new Function('return 1')(); result.eval = true; } catch { result.eval = false; }
	result.credentials = Object.keys(process.env).some(key => key.startsWith('PROTONMAIL_'));
	const socket = net.createConnection({ host: '127.0.0.1', port: 9 });
	socket.once('connect', () => { result.network = true; socket.destroy(); });
	socket.once('error', error => { result.network = error.code !== 'EPERM' && error.code !== 'EACCES'; });
	socket.once('close', () => process.stdout.write(JSON.stringify(result)));
	`);
	const protectedPolicy = join(directory, "policy.json");
	await writeFile(protectedPolicy, "protected policy fixture");
	t.after(async () => {
		await rm(directory, { recursive: true, force: true });
		await rm(secrets, { recursive: true, force: true });
	});
	assert.deepEqual(
		JSON.parse(
			(
				await runPdfSandbox({
					directory,
					input: Buffer.alloc(0),
					protectedFiles: [protectedPolicy],
				})
			).toString(),
		),
		{
			read: false,
			policy: false,
			write: false,
			fork: false,
			eval: false,
			credentials: false,
			network: false,
		},
	);
});

test("PDF sandbox terminates processes that exceed time, resident memory, or output budgets", {
	skip: process.platform !== "darwin",
	timeout: 20_000,
}, async () => {
	for (const [code, reason] of [
		["setInterval(() => {}, 1000)", /10 second/],
		[
			"global.bytes = Buffer.alloc(300 * 1024 * 1024, 1); setInterval(() => {}, 1000)",
			/memory limit/,
		],
		["process.stdout.write('A'.repeat(700000))", /output limit/],
	] satisfies [string, RegExp][]) {
		const directory = await sandboxFixture(code);
		try {
			await assert.rejects(
				runPdfSandbox({
					directory,
					input: Buffer.alloc(0),
					protectedFiles: [],
				}),
				reason,
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
});

test("unsupported platforms refuse PDF extraction rather than run an unsandboxed parser", {
	skip: process.platform === "darwin",
}, async () => {
	await assert.rejects(
		extractPdf(pdfFixture(), { protectedFiles: [] }),
		/isolation is unavailable/,
	);
});
