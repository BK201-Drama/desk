import { spawnSync } from "node:child_process";
import fs from "node:fs";

function run(command) {
  const result = spawnSync(command, {
    shell: true,
    encoding: "utf8",
    cwd: process.cwd(),
    maxBuffer: 10_000_000,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { command, exitCode: result.status ?? 1, output: output.slice(-8000) };
}

const steps = [run("npm run arch")];
if (steps[0].exitCode === 0) steps.push(run("npm run test:e2e"));

const passed = steps.every((step) => step.exitCode === 0);
fs.writeFileSync("gate-report.json", `${JSON.stringify({ passed, steps }, null, 2)}\n`);
if (!passed) {
  for (const step of steps) {
    if (step.exitCode !== 0) process.stderr.write(step.output);
  }
  process.exit(1);
}
process.stdout.write("gate: arch and test:e2e passed\n");
