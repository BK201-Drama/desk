import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, ".githooks", "pre-commit");
if (!fs.existsSync(src)) process.exit(0);

let gitDir = path.join(root, ".git");
if (fs.existsSync(gitDir) && fs.statSync(gitDir).isFile()) {
  const text = fs.readFileSync(gitDir, "utf8");
  const found = text.match(/^gitdir:\s*(.+)$/m);
  if (found) gitDir = path.resolve(root, found[1].trim());
}
if (!fs.existsSync(gitDir)) process.exit(0);

const destDir = path.join(gitDir, "hooks");
fs.mkdirSync(destDir, { recursive: true });
const dest = path.join(destDir, "pre-commit");
fs.copyFileSync(src, dest);
try {
  fs.chmodSync(dest, 0o755);
} catch {
  // Windows 上可执行位可以缺省，Git Bash 仍会按 shebang 运行。
}
