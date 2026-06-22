#!/usr/bin/env bun
/**
 * StartupSelfCheckSmokeTest
 *
 * Verifies the lightweight startup self-check hook is installed, registered in
 * Codex hooks.json generation, and emits an advisory reminder when a critical
 * runtime surface is missing.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

type Check = {
  name: string;
  passed: boolean;
  detail: string;
};

function check(name: string, passed: boolean, detail: string): Check {
  return { name, passed, detail };
}

function print(checks: Check[]) {
  for (const item of checks) {
    console.log(`${item.passed ? "PASS" : "FAIL"} ${item.name} - ${item.detail}`);
  }
}

const keep = process.argv.includes("--keep");
const frameworkRoot = process.env.PAI_FRAMEWORK_DIR || process.env.CODEX_HOME || join(process.env.HOME || "", ".codex");
const paiDir = process.env.PAI_DIR || join(frameworkRoot, "PAI");
const hookPath = join(frameworkRoot, "hooks", "StartupSelfCheck.hook.ts");
const hooksJsonPath = join(frameworkRoot, "hooks.json");
const configGenPath = join(paiDir, "PAI-Install", "engine", "config-gen.ts");
const paiToolPath = join(paiDir, "TOOLS", "pai.ts");

const root = join(tmpdir(), `pai-startup-self-check-${Date.now()}-${Math.random().toString(16).slice(2)}`);
const tempFramework = join(root, "framework");
const tempData = join(root, "data");
mkdirSync(tempFramework, { recursive: true });
mkdirSync(tempData, { recursive: true });
writeFileSync(join(tempFramework, "config.toml"), [
  "# BEGIN PAI MANAGED ROOT CONFIG",
  "# END PAI MANAGED ROOT CONFIG",
  "# BEGIN PAI MANAGED MCP CONFIG",
  "# END PAI MANAGED MCP CONFIG",
].join("\n"));
writeFileSync(join(tempFramework, "hooks.json"), JSON.stringify({ hooks: { SessionStart: [] } }));
mkdirSync(join(tempFramework, "MCPs"), { recursive: true });
writeFileSync(join(tempFramework, "MCPs", "none.mcp.json"), JSON.stringify({ mcpServers: {} }));

const run = spawnSync(process.execPath, [hookPath], {
  encoding: "utf-8",
  timeout: 10_000,
  env: {
    ...process.env,
    PAI_FRAMEWORK: "codex",
    PAI_FRAMEWORK_DIR: tempFramework,
    PAI_DIR: join(tempFramework, "PAI"),
    PAI_DATA_DIR: tempData,
    PAI_SETTINGS_PATH: join(tempFramework, "settings.json"),
  },
  input: JSON.stringify({ session_id: "startup-self-check-smoke", source: "startup" }),
});

const output = `${run.stdout || ""}${run.stderr || ""}`;
const hooksJson = existsSync(hooksJsonPath) ? readFileSync(hooksJsonPath, "utf-8") : "";
const configGen = existsSync(configGenPath) ? readFileSync(configGenPath, "utf-8") : "";
const paiTool = existsSync(paiToolPath) ? readFileSync(paiToolPath, "utf-8") : "";

const checks: Check[] = [
  check("StartupSelfCheck hook exists", existsSync(hookPath), hookPath),
  check("live hooks.json registers StartupSelfCheck", hooksJson.includes("StartupSelfCheck.hook.ts"), hooksJsonPath),
  check("installer hook generator registers StartupSelfCheck", configGen.includes("StartupSelfCheck.hook.ts"), configGenPath),
  check("pai tool hook generator registers StartupSelfCheck", paiTool.includes("StartupSelfCheck.hook.ts"), paiToolPath),
  check("self-check exits cleanly", run.status === 0, `status=${run.status ?? "null"}`),
  check("self-check reports missing AGENTS.md", output.includes("AGENTS.md exists"), output.trim().split("\n").slice(0, 4).join(" | ")),
  check("self-check points to k doctor", output.includes("k doctor"), output.trim().split("\n").slice(-2).join(" | ")),
];

print(checks);

if (keep) {
  console.log(`\nKept smoke root: ${root}`);
} else {
  rmSync(root, { recursive: true, force: true });
}

const failed = checks.filter((item) => !item.passed);
if (failed.length > 0) {
  console.error(`\n${failed.length} startup self-check smoke check(s) failed.`);
  process.exit(1);
}

console.log("\nAll startup self-check smoke checks passed.");
