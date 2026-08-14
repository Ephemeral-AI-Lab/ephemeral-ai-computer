// Run Vitest with the Linux workspace runtime when the host is Windows.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptPath = fileURLToPath(import.meta.url);
const workspaceRoot = path.resolve(path.dirname(scriptPath), "..");
const runRoot = process.cwd();
const args = process.argv.slice(2);

function quote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function wslPath(value) {
  const normalized = value.replaceAll("\\", "/");
  const match = /^([A-Za-z]):(\/.*)?$/u.exec(normalized);
  if (!match) throw new Error(`cannot map Windows path to WSL: ${value}`);
  return `/mnt/${match[1].toLowerCase()}${match[2] ?? "/"}`;
}

const vitestEntry = path.join(workspaceRoot, "node_modules", "vitest", "vitest.mjs");
const testRuntimeArgs = ["--maxWorkers=1", ...args];
const result =
  process.platform === "win32"
    ? spawnSync(
        "wsl.exe",
        [
          "--",
          "bash",
          "-lc",
          `cd ${quote(wslPath(runRoot))} && exec node ${quote(
            wslPath(vitestEntry)
          )} run ${testRuntimeArgs.map(quote).join(" ")}`,
        ],
        { stdio: "inherit", windowsHide: true }
      )
    : spawnSync(process.execPath, [vitestEntry, "run", ...testRuntimeArgs], {
        cwd: runRoot,
        stdio: "inherit",
      });

if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
process.exitCode = result.status ?? 1;
