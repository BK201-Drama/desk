import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const harnessFlag = process.argv.indexOf("--harness");
const harness = harnessFlag >= 0 ? process.argv[harnessFlag + 1] : "";

if (process.env.GATE_CHECKED === "1") process.exit(0);

function emit(followup, exitCode = 0) {
  if (!harness) {
    const stream = exitCode === 0 ? process.stdout : process.stderr;
    if (followup) stream.write(`${followup}\n`);
    process.exit(exitCode);
  }
  if (!followup) {
    process.stdout.write("{}\n");
    process.exit(0);
  }
  if (harness === "cursor") {
    process.stdout.write(`${JSON.stringify({ followup_message: followup })}\n`);
  } else {
    process.stdout.write(
      `${JSON.stringify({ decision: "block", reason: followup })}\n`,
    );
  }
  process.exit(0);
}

function loadCommands() {
  const file = path.join(root, "GATE.md");
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return { architecture: [], acceptance: [] };
  const close = text.indexOf("\n---", 3);
  const yaml = close < 0 ? "" : text.slice(4, close);
  const architecture = [];
  const acceptance = [];
  let list = null;
  for (const line of yaml.split("\n")) {
    if (!line.trim()) continue;
    const item = line.match(/^  - (.*)$/);
    if (item) {
      if (list) list.push(item[1]);
      continue;
    }
    const key = line.match(/^([a-z_]+):/);
    if (!key) continue;
    if (key[1] === "architecture") list = architecture;
    else if (key[1] === "acceptance") list = acceptance;
    else list = null;
  }
  return { architecture, acceptance };
}

function porcelain() {
  const result = spawnSync(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    { cwd: root, encoding: "utf8" },
  );
  if ((result.status ?? 1) !== 0) return null;
  return (result.stdout ?? "")
    .split(/\r?\n/)
    .filter(
      (line) =>
        line &&
        !line.includes(".gate/") &&
        !line.includes("GATE.report.json"),
    )
    .join("\n");
}

function stampPath() {
  return path.join(root, ".gate", "stamp.json");
}

function readStamp() {
  try {
    return JSON.parse(fs.readFileSync(stampPath(), "utf8"));
  } catch {
    return null;
  }
}

function writeStamp(stamp) {
  fs.mkdirSync(path.dirname(stampPath()), { recursive: true });
  fs.writeFileSync(stampPath(), `${JSON.stringify(stamp)}\n`);
}

function git(args, env = process.env) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8", env });
}

function pathFromStatus(line) {
  const body = line.slice(3).trim();
  const renamed = body.split(" -> ").pop() ?? body;
  return renamed.replaceAll('"', "");
}

function isSecret(file) {
  const base = path.basename(file);
  return (
    base === ".env" ||
    base.startsWith(".env.") ||
    base === "credentials.json" ||
    base === "id_rsa" ||
    base.endsWith(".pem")
  );
}

function publish() {
  const lines = (porcelain() ?? "").split("\n").filter(Boolean);
  if (lines.length === 0) return "没有需要提交的改动";
  const skipped = [];
  const files = [];
  for (const line of lines) {
    const file = pathFromStatus(line);
    if (isSecret(file)) skipped.push(file);
    else files.push(file);
  }
  if (files.length === 0) {
    return `未提交：${skipped.join(", ")} 看起来是凭证`;
  }
  const add = git(["add", "--", ...files]);
  if ((add.status ?? 1) !== 0) {
    return `git add 失败\n${add.stderr || add.stdout || ""}`.slice(-1500);
  }
  const commit = git(
    ["commit", "-m", "gate: keep the changes that passed arch and e2e"],
    { ...process.env, GATE_CHECKED: "1" },
  );
  if ((commit.status ?? 1) !== 0) {
    return `git commit 失败\n${commit.stderr || commit.stdout || ""}`.slice(-1500);
  }
  const hash = (git(["rev-parse", "--short", "HEAD"]).stdout ?? "").trim();
  const branch = (git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout ?? "").trim();
  const remotes = (git(["remote"]).stdout ?? "").split(/\r?\n/);
  let pushNote = "没有远程，未推送";
  if (remotes.includes("origin") && branch && branch !== "HEAD") {
    const push = git(["push", "origin", branch]);
    pushNote =
      (push.status ?? 1) === 0
        ? `已推送 origin/${branch}`
        : `提交已在本地，推送失败\n${(push.stderr || push.stdout || "").slice(-1500)}`;
  }
  const skipNote = skipped.length ? `\n未纳入提交：${skipped.join(", ")}` : "";
  return `已提交 ${hash}\n${pushNote}${skipNote}`;
}

function run(command) {
  const result = spawnSync(command, {
    cwd: root,
    shell: true,
    encoding: "utf8",
    maxBuffer: 10_000_000,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-8000);
  return { command, exitCode: result.status ?? 1, output };
}

async function readInput() {
  if (!harness || process.stdin.isTTY) return {};
  const raw = await new Response(process.stdin).text();
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const input = await readInput();
if (harness === "cursor" && input.status && input.status !== "completed") emit("");

const card = loadCommands();
if (!card) emit("");
if (card.architecture.length === 0 || card.acceptance.length === 0) {
  emit("gate 被拒绝：GATE.md 的 architecture 和 acceptance 都不能空。不要改代码，把这句话告诉用户。", 2);
}

const before = porcelain();
const stamp = readStamp();
if (harness && before !== null && stamp && stamp.fingerprint === before) emit("");

const architecture = card.architecture.map(run);
const acceptance = card.acceptance.map(run);
const passed = [...architecture, ...acceptance].every((step) => step.exitCode === 0);
const strikes = passed ? 0 : (stamp?.strikes ?? 0) + 1;
const report = { passed, attempts: strikes, architecture, acceptance };
fs.writeFileSync(path.join(root, "GATE.report.json"), `${JSON.stringify(report, null, 2)}\n`);
const publishNote = passed && harness ? publish() : "";
const after = porcelain();
writeStamp({ fingerprint: after ?? before, strikes, passed });

const failed = [...architecture, ...acceptance].filter((step) => step.exitCode !== 0);
const summary = [
  `passed=${passed} attempts=${strikes}`,
  ...[...architecture, ...acceptance].map(
    (step) => `${step.exitCode === 0 ? "通过" : "失败"} ${step.command} 退出码 ${step.exitCode}`,
  ),
].join("\n");

if (passed) {
  const needsAttention =
    publishNote.startsWith("git ") ||
    publishNote.includes("推送失败") ||
    publishNote.includes("未纳入提交");
  if (!needsAttention) emit("");
  emit(
    `gate 已通过，但提交或推送没有完成。用中文把下面的报告告诉用户。不要改代码。\n${summary}\n${publishNote}`,
    0,
  );
}
if (strikes >= 3) {
  emit(
    `gate 已失败 ${strikes} 次。用中文把报告告诉用户，不要再改代码。\n${summary}\n${failed.map((step) => step.output).join("\n").slice(-4000)}`,
    1,
  );
}
emit(
  `gate 失败。按下面原文改，不要放宽 GATE.md 里的命令，也不要改规则来放水。改完就停。\n${summary}\n${failed.map((step) => step.output).join("\n").slice(-4000)}`,
  1,
);
