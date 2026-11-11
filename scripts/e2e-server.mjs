import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freeE2EPort } from "./free-e2e-port.mjs";

const port = 4173;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", shell: true });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    // 进程可能已经退出。
  }
}

await freeE2EPort();
const buildCode = await run("npm", ["run", "build"]);
if (buildCode !== 0) process.exit(buildCode);
await freeE2EPort();

const viteBin = path.join(root, "node_modules", "vite", "bin", "vite.js");
const preview = spawn(
  process.execPath,
  [viteBin, "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  { cwd: root, stdio: "inherit" },
);

const stop = () => killTree(preview.pid);
process.on("SIGINT", () => {
  stop();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stop();
  process.exit(0);
});
preview.on("exit", (code) => process.exit(code ?? 0));
