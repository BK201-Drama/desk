import { execFileSync } from "node:child_process";

const port = 4173;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function listeningPids() {
  if (process.platform !== "win32") {
    try {
      const out = execFileSync("lsof", ["-ti", `tcp:${port}`], { encoding: "utf8" });
      return [...new Set(out.trim().split(/\s+/).map(Number).filter((pid) => pid > 0))];
    } catch {
      return [];
    }
  }
  const out = execFileSync("netstat", ["-ano"], { encoding: "utf8" });
  const pids = new Set();
  for (const line of out.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[3] !== "LISTENING") continue;
    if (!parts[1].endsWith(`:${port}`)) continue;
    const pid = Number(parts[4]);
    if (pid > 0) pids.add(pid);
  }
  return [...pids];
}

function processName(pid) {
  if (process.platform !== "win32") {
    try {
      return execFileSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  }
  try {
    const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
      encoding: "utf8",
    });
    return out.match(/^"([^"]+)"/)?.[1] ?? "";
  } catch {
    return "";
  }
}

function killTree(pid) {
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    // 进程可能已经退出。
  }
}

export async function freeE2EPort() {
  for (let attempt = 0; attempt < 25; attempt++) {
    const pids = listeningPids();
    if (pids.length === 0) return;
    for (const pid of pids) {
      if (/^(node|npm|cmd|vite)(\.exe)?$/i.test(processName(pid))) killTree(pid);
    }
    await sleep(200);
  }
}

export default async function globalSetup() {
  await freeE2EPort();
}

if (process.argv[1]?.endsWith("free-e2e-port.mjs")) await freeE2EPort();
