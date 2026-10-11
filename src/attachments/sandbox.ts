import { execFile, spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
	MAX_ATTACHMENT_CHARACTERS,
	PDF_MEMORY_BYTES,
	PDF_TIMEOUT_MS,
} from "./limits.js";

const execute = promisify(execFile);
const MAX_OUTPUT_BYTES = MAX_ATTACHMENT_CHARACTERS * 6 + 4096;

export async function runPdfSandbox({
	directory,
	input,
	protectedFiles,
}: {
	directory: string;
	input: Buffer;
	protectedFiles: readonly string[];
}): Promise<Buffer> {
	if (process.platform !== "darwin")
		throw new Error(
			"PDF isolation is unavailable on this platform. PDF inspection currently requires macOS sandbox-exec. Read this attachment in Proton Mail.",
		);
	const executable = await realpath(process.execPath);
	const runtimeDirectory = await realpath(directory);
	const protectedPaths = await Promise.all(
		protectedFiles.map((path) => realpath(path).catch(() => resolve(path))),
	);
	// Only the runtime, OS libraries, and a private directory containing parser code
	// are readable. No application files, credentials, network, writes, or forks.
	const quote = (path: string) => JSON.stringify(path);
	const runtimeReads = [
		`(literal ${quote(executable)})`,
		`(subpath ${quote(runtimeDirectory)})`,
		'(literal "/")',
		'(subpath "/usr/lib")',
		'(subpath "/System/Library")',
		'(literal "/dev/null")',
		'(literal "/dev/urandom")',
	].join(" ");
	const profile = `(version 1)(deny default)
		(allow process-exec (literal ${quote(executable)}))
		(allow file-read-metadata)
		(allow file-read* ${runtimeReads})
		${protectedPaths.map((path) => `(deny file-read* (literal ${quote(path)}))`).join("\n")}
		(allow file-map-executable ${runtimeReads})
		(allow sysctl-read)
		(allow signal (target self))`;
	return new Promise((resolve, reject) => {
		const child = spawn(
			"/usr/bin/sandbox-exec",
			[
				"-p",
				profile,
				executable,
				"--no-addons",
				"--disallow-code-generation-from-strings",
				"--disable-proto=throw",
				"--max-old-space-size=128",
				join(runtimeDirectory, "pdf-worker.js"),
			],
			{
				cwd: runtimeDirectory,
				env: { LANG: "C", LC_ALL: "C", TMPDIR: runtimeDirectory },
				stdio: "pipe",
			},
		);
		let failure: Error | undefined;
		let outputSize = 0;
		const output: Buffer[] = [];
		function stop(reason: string) {
			failure ??= new Error(reason);
			child.kill("SIGKILL");
		}
		const timeout = setTimeout(
			() => stop("PDF extraction exceeded the 10 second limit."),
			PDF_TIMEOUT_MS,
		);
		let checkingMemory = false;
		const memoryCheck = setInterval(async () => {
			if (
				checkingMemory ||
				child.exitCode !== null ||
				child.signalCode !== null ||
				!child.pid
			)
				return;
			checkingMemory = true;
			try {
				const { stdout } = await execute(
					"/bin/ps",
					["-o", "rss=", "-p", String(child.pid)],
					{ timeout: 1000, maxBuffer: 1024, env: { LC_ALL: "C" } },
				);
				if (!/^\s*\d+\s*$/.test(stdout))
					stop("Unable to enforce the PDF memory limit.");
				else if (Number(stdout.trim()) * 1024 > PDF_MEMORY_BYTES)
					stop("PDF extraction exceeded the 256 MiB memory limit.");
			} catch {
				if (child.exitCode === null && child.signalCode === null)
					stop("Unable to enforce the PDF memory limit.");
			} finally {
				checkingMemory = false;
			}
		}, 50);
		child.stdout.on("data", (chunk: Buffer) => {
			outputSize += chunk.length;
			if (outputSize > MAX_OUTPUT_BYTES)
				stop("PDF extraction exceeded the output limit.");
			else output.push(chunk);
		});
		// Drain diagnostics without forwarding untrusted parser output to MCP stdout.
		child.stderr.resume();
		child.stdin.on("error", () =>
			stop(
				"PDF isolation or extraction failed. No attachment text was returned.",
			),
		);
		child.on("error", () =>
			stop("PDF isolation could not start. No attachment text was returned."),
		);
		child.on("close", (code) => {
			clearTimeout(timeout);
			clearInterval(memoryCheck);
			if (failure) reject(failure);
			else if (code !== 0)
				reject(
					new Error(
						"PDF isolation or extraction failed. No attachment text was returned.",
					),
				);
			else resolve(Buffer.concat(output, outputSize));
		});
		child.stdin.end(input);
	});
}
