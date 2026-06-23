#!/usr/bin/env bun
/**
 * HotfixUpdateRollbackSmokeTest
 *
 * Proves the installed hotfix updater can patch an old Codex install, create
 * backups under ~/.pai/BACKUPS, leave protected state alone, and roll back by
 * overlaying the backup contents onto the install root.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf-8") : "";
}

function latestBackupRoot(home: string): string {
  const backups = join(home, ".pai", "BACKUPS");
  if (!existsSync(backups)) return "";
  const entries = readdirSync(backups, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("hotfix-"))
    .map((entry) => join(backups, entry.name))
    .sort();
  return entries.at(-1) || "";
}

function copyDirectoryContents(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const src = join(source, entry.name);
    const dst = join(destination, entry.name);
    cpSync(src, dst, { recursive: true, force: true });
  }
}

const keep = process.argv.includes("--keep");
const remote = process.argv.includes("--remote");
const releaseRoot = resolve(import.meta.dir, "..", "..");
const repoRoot = resolve(releaseRoot, "..", "..", "..");
const repoSourceRoot = existsSync(join(repoRoot, "Releases", "v5.0.0", ".claude", "hotfix-manifest.json"))
  ? repoRoot
  : releaseRoot;
const root = join(tmpdir(), `pai-hotfix-rollback-smoke-${Date.now()}-${Math.random().toString(16).slice(2)}`);
const home = join(root, "home");
const installRoot = join(root, "old-codex");
const dataDir = join(home, ".pai");

const sentinels = {
  agents: "OLD_AGENTS_SENTINEL",
  paiTool: "OLD_PAI_TOOL_SENTINEL",
  repeatHook: "OLD_REPEAT_HOOK_SENTINEL",
  promptGuardHook: "OLD_PROMPT_GUARD_HOOK_SENTINEL",
  config: "PROTECTED_CONFIG_SENTINEL",
  auth: "PROTECTED_AUTH_SENTINEL",
  user: "PROTECTED_USER_SENTINEL",
  memory: "PROTECTED_MEMORY_SENTINEL",
};

mkdirSync(installRoot, { recursive: true });
mkdirSync(dataDir, { recursive: true });
write(join(installRoot, "AGENTS.md"), sentinels.agents);
write(join(installRoot, "PAI", "TOOLS", "pai.ts"), sentinels.paiTool);
write(join(installRoot, "hooks", "RepeatDetection.hook.ts"), sentinels.repeatHook);
write(join(installRoot, "hooks", "PromptGuard.hook.ts"), sentinels.promptGuardHook);
write(join(installRoot, "PAI", "ALGORITHM", "LATEST"), "6.3.0");
write(join(installRoot, "PAI", "ALGORITHM", "v6.3.0.md"), "# old algorithm placeholder");
write(join(installRoot, "config.toml"), sentinels.config);
write(join(installRoot, "auth.json"), sentinels.auth);
write(join(installRoot, "PAI", "USER", "profile.md"), sentinels.user);
write(join(installRoot, "MEMORY", "STATE", "state.json"), sentinels.memory);

const updateCommand = process.platform === "win32" ? "powershell" : "bash";
const updateArgs = process.platform === "win32"
  ? [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(releaseRoot, "update-installed.ps1"),
      "-Framework",
      "codex",
      "-InstallRoot",
      installRoot,
      "-NoPull",
    ]
  : [
      join(releaseRoot, "update-installed.sh"),
      "--framework",
      "codex",
      "--install-root",
      installRoot,
      "--no-pull",
    ];
if (!remote) {
  if (process.platform === "win32") updateArgs.push("-SourceDir", repoSourceRoot);
  else updateArgs.push("--source-dir", repoSourceRoot);
}

const update = spawnSync(updateCommand, updateArgs, {
  cwd: repoRoot,
  encoding: "utf-8",
  timeout: 180_000,
  maxBuffer: 20 * 1024 * 1024,
  env: {
    ...process.env,
    HOME: home,
    CODEX_HOME: installRoot,
    PAI_DATA_DIR: dataDir,
    PAI_FRAMEWORK: "codex",
  },
});

const backupRoot = latestBackupRoot(home);
const updatedPaiTool = read(join(installRoot, "PAI", "TOOLS", "pai.ts"));
const updatedRepeatHook = read(join(installRoot, "hooks", "RepeatDetection.hook.ts"));
const updatedPromptGuardHook = read(join(installRoot, "hooks", "PromptGuard.hook.ts"));

const beforeRollbackChecks: Check[] = [
  check("hotfix update exits cleanly", update.status === 0, `status=${update.status ?? "null"} ${update.stderr.split(/\r?\n/).slice(-4).join(" | ")}`),
  check("backup root created", backupRoot.length > 0, backupRoot || "missing"),
  check("AGENTS.md backup captured old content", read(join(backupRoot, "AGENTS.md")) === sentinels.agents, join(backupRoot, "AGENTS.md")),
  check("pai.ts backup captured old content", read(join(backupRoot, "PAI", "TOOLS", "pai.ts")) === sentinels.paiTool, join(backupRoot, "PAI", "TOOLS", "pai.ts")),
  check("RepeatDetection backup captured old content", read(join(backupRoot, "hooks", "RepeatDetection.hook.ts")) === sentinels.repeatHook, join(backupRoot, "hooks", "RepeatDetection.hook.ts")),
  check("PromptGuard backup captured old content", read(join(backupRoot, "hooks", "PromptGuard.hook.ts")) === sentinels.promptGuardHook, join(backupRoot, "hooks", "PromptGuard.hook.ts")),
  check("pai.ts updated from release", updatedPaiTool.includes("Run PAI runtime diagnostics"), join(installRoot, "PAI", "TOOLS", "pai.ts")),
  check("RepeatDetection updated from release", updatedRepeatHook.includes("Continue by addressing the newest request directly"), join(installRoot, "hooks", "RepeatDetection.hook.ts")),
  check("PromptGuard updated from release", updatedPromptGuardHook.includes("process.exitCode = 2"), join(installRoot, "hooks", "PromptGuard.hook.ts")),
  check("config.toml protected", read(join(installRoot, "config.toml")) === sentinels.config, join(installRoot, "config.toml")),
  check("auth.json protected", read(join(installRoot, "auth.json")) === sentinels.auth, join(installRoot, "auth.json")),
  check("USER protected", read(join(installRoot, "PAI", "USER", "profile.md")) === sentinels.user, join(installRoot, "PAI", "USER", "profile.md")),
  check("MEMORY protected", read(join(installRoot, "MEMORY", "STATE", "state.json")) === sentinels.memory, join(installRoot, "MEMORY", "STATE", "state.json")),
];

if (backupRoot) copyDirectoryContents(backupRoot, installRoot);

const rollbackChecks: Check[] = [
  check("rollback restores AGENTS.md", read(join(installRoot, "AGENTS.md")) === sentinels.agents, join(installRoot, "AGENTS.md")),
  check("rollback restores pai.ts", read(join(installRoot, "PAI", "TOOLS", "pai.ts")) === sentinels.paiTool, join(installRoot, "PAI", "TOOLS", "pai.ts")),
  check("rollback restores RepeatDetection", read(join(installRoot, "hooks", "RepeatDetection.hook.ts")) === sentinels.repeatHook, join(installRoot, "hooks", "RepeatDetection.hook.ts")),
  check("rollback restores PromptGuard", read(join(installRoot, "hooks", "PromptGuard.hook.ts")) === sentinels.promptGuardHook, join(installRoot, "hooks", "PromptGuard.hook.ts")),
];

const checks = [...beforeRollbackChecks, ...rollbackChecks];
print(checks);

if (keep) {
  console.log(`\nKept smoke root: ${root}`);
} else {
  rmSync(root, { recursive: true, force: true });
}

const failed = checks.filter((item) => !item.passed);
if (failed.length > 0) {
  console.error(`\n${failed.length} hotfix update/rollback smoke check(s) failed.`);
  process.exit(1);
}

console.log(`\nAll hotfix update/rollback smoke checks passed.${remote ? " (remote branch source)" : ""}`);
