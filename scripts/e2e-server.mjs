import { spawn, execFileSync } from "node:child_process";

const port = 4173;

function listeningPid() {
  if (process.platform === "win32") {
    const out = execFileSync("netstat", ["-ano"], { encoding: "utf8" });
    for (const line of out.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.includes(`:${port}`) || !trimmed.includes("LISTENING")) continue;
      const pid = Number(trimmed.split(/\s+/).pop());
      if (pid > 0) return pid;
    }
    return 0;
  }
  try {
    const out = execFileSync("lsof", ["-ti", `tcp:${port}`], { encoding: "utf8" });
    return Number(out.trim().split(/\s+/)[0]) || 0;
  } catch {
    return 0;
  }
}

function commandLine(pid) {
  try {
    if (process.platform === "win32") {
      return execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
        ],
        { encoding: "utf8" },
      );
    }
    return execFileSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" });
  } catch {
    return "";
  }
}

function freePort() {
  const pid = listeningPid();
  if (!pid) return;
  const line = commandLine(pid);
  if (!/vite|preview/i.test(line)) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"]);
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    // 进程可能已经退出。
  }
}

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit", shell: true });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

freePort();
const buildCode = await run("npm", ["run", "build"]);
if (buildCode !== 0) process.exit(buildCode);
freePort();
const preview = spawn(
  "npm",
  ["run", "preview", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  { stdio: "inherit", shell: true },
);
const stop = () => preview.kill();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
preview.on("exit", (code) => process.exit(code ?? 0));
