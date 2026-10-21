import { spawnSync } from "node:child_process";
import { chmodSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { replaceTscAliasPaths } from "tsc-alias";

rmSync(new URL("../build", import.meta.url), { recursive: true, force: true });
const tsc = fileURLToPath(
	new URL("../node_modules/typescript/bin/tsc", import.meta.url),
);
const result = spawnSync(process.execPath, [tsc], { stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
await replaceTscAliasPaths({
	configFile: fileURLToPath(new URL("../tsconfig.json", import.meta.url)),
});
if (process.platform !== "win32")
	chmodSync(new URL("../build/index.js", import.meta.url), 0o755);
