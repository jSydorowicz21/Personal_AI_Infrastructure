#!/usr/bin/env bun
/**
 * HotfixUpdateRollbackSmokeTest
 *
 * Proves the installed hotfix updater can patch an old Codex install, create
 * backups under ~/.pai/BACKUPS, leave protected state alone, and roll back by
 * overlaying the backup contents onto the install root.
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

function normalizePathText(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

function codexHookDataDirs(hooksJson: string): string[] {
  const values: string[] = [];
  function visit(value: unknown): void {
    if (typeof value === "string") {
      for (const match of value.matchAll(/(?:^|\s)PAI_DATA_DIR='([^']*)'/g)) {
        values.push(match[1]);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value as Record<string, unknown>)) visit(item);
    }
  }
  try {
    visit(JSON.parse(hooksJson));
  } catch {}
  return values;
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

function copyInstalledSourceFixture(source: string, destination: string): void {
  const skipSegments = new Set([".git", ".tmp", "node_modules", "plugins", "MEMORY", "USER"]);
  cpSync(source, destination, {
    recursive: true,
    force: true,
    filter: (path) => !path.split(/[\\/]+/).some((segment) => skipSegments.has(segment)),
  });
}

const keep = process.argv.includes("--keep");
const remote = process.argv.includes("--remote");
const releaseRoot = resolve(import.meta.dir, "..", "..");
const repoRoot = resolve(releaseRoot, "..", "..", "..");
const root = join(tmpdir(), `pai-hotfix-rollback-smoke-${Date.now()}-${Math.random().toString(16).slice(2)}`);
const home = join(root, "home");
const oneDriveRoot = join(home, "OneDrive");
const installRoot = join(root, "old-codex");
const installedSourceRoot = join(root, "installed-source");
const dataDir = join(home, ".pai");
const configDir = join(home, ".config", "PAI");
const staleEnvDataDir = join(root, "stale-env", ".pai");
const linkedToolsTarget = join(root, "linked-tools-target");

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
mkdirSync(staleEnvDataDir, { recursive: true });
mkdirSync(linkedToolsTarget, { recursive: true });
copyInstalledSourceFixture(releaseRoot, installedSourceRoot);
write(join(installedSourceRoot, "CLAUDE.md"), "**MANDATORY FIRST ACTION:** Read `PAI/ALGORITHM/LATEST` from the current directory.");
write(join(installedSourceRoot, "AGENTS.md"), "**MANDATORY FIRST ACTION:** Read `$PAI_DIR/ALGORITHM/LATEST` from the active PAI subsystem directory.");
write(join(dataDir, "framework.json"), JSON.stringify({ active: "codex", root: installRoot, dataDir }, null, 2));
write(join(staleEnvDataDir, "framework.json"), JSON.stringify({
  active: "codex",
  root: join(root, "deleted-codex"),
  dataDir: staleEnvDataDir,
}, null, 2));
write(join(installRoot, "AGENTS.md"), sentinels.agents);
write(join(linkedToolsTarget, "pai.ts"), sentinels.paiTool);
write(join(linkedToolsTarget, "ExtraTool.ts"), "LINKED_EXTRA_TOOL_SENTINEL");
mkdirSync(join(installRoot, "PAI"), { recursive: true });
symlinkSync(linkedToolsTarget, join(installRoot, "PAI", "TOOLS"), process.platform === "win32" ? "junction" : "dir");
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
  if (process.platform === "win32") updateArgs.push("-SourceDir", installedSourceRoot);
  else updateArgs.push("--source-dir", installedSourceRoot);
}

const update = spawnSync(updateCommand, updateArgs, {
  cwd: repoRoot,
  encoding: "utf-8",
  timeout: 180_000,
  maxBuffer: 20 * 1024 * 1024,
  env: {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    OneDrive: oneDriveRoot,
    CODEX_HOME: installRoot,
    PAI_DATA_DIR: staleEnvDataDir,
    PAI_CONFIG_DIR: configDir,
    PAI_FRAMEWORK_DIR: join(root, "deleted-codex"),
    PAI_FRAMEWORK: "codex",
    PAI_USER_ENV_TARGET: "Process",
  },
});

const backupRoot = latestBackupRoot(home);
const updatedPaiTool = read(join(installRoot, "PAI", "TOOLS", "pai.ts"));
const linkedToolsStats = existsSync(join(installRoot, "PAI", "TOOLS")) ? lstatSync(join(installRoot, "PAI", "TOOLS")) : null;
const updatedRepeatHook = read(join(installRoot, "hooks", "RepeatDetection.hook.ts"));
const updatedPromptGuardHook = read(join(installRoot, "hooks", "PromptGuard.hook.ts"));
const updatedHooksJson = read(join(installRoot, "hooks.json"));
const hookDataDirs = codexHookDataDirs(updatedHooksJson).map(normalizePathText);
const expectedHookDataSuffix = normalizePathText(join("home", ".pai"));
const staleHookDataSegment = normalizePathText(join("stale-env", ".pai"));
const powerShellAllHostsProfile = join(home, "Documents", "PowerShell", "profile.ps1");
const powerShellProfile = join(home, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1");
const windowsPowerShellAllHostsProfile = join(home, "Documents", "WindowsPowerShell", "profile.ps1");
const windowsPowerShellProfile = join(home, "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1");
const oneDrivePowerShellAllHostsProfile = join(oneDriveRoot, "Documents", "PowerShell", "profile.ps1");
const oneDrivePowerShellProfile = join(oneDriveRoot, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1");
const oneDriveWindowsPowerShellAllHostsProfile = join(oneDriveRoot, "Documents", "WindowsPowerShell", "profile.ps1");
const oneDriveWindowsPowerShellProfile = join(oneDriveRoot, "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1");
const powerShellAllHostsProfileText = read(powerShellAllHostsProfile);
const powerShellProfileText = read(powerShellProfile);
const windowsPowerShellAllHostsProfileText = read(windowsPowerShellAllHostsProfile);
const windowsPowerShellProfileText = read(windowsPowerShellProfile);
const oneDrivePowerShellAllHostsProfileText = read(oneDrivePowerShellAllHostsProfile);
const oneDrivePowerShellProfileText = read(oneDrivePowerShellProfile);
const oneDriveWindowsPowerShellAllHostsProfileText = read(oneDriveWindowsPowerShellAllHostsProfile);
const oneDriveWindowsPowerShellProfileText = read(oneDriveWindowsPowerShellProfile);
const profileTexts = [
  powerShellAllHostsProfileText,
  powerShellProfileText,
  windowsPowerShellAllHostsProfileText,
  windowsPowerShellProfileText,
  oneDrivePowerShellAllHostsProfileText,
  oneDrivePowerShellProfileText,
  oneDriveWindowsPowerShellAllHostsProfileText,
  oneDriveWindowsPowerShellProfileText,
];

const beforeRollbackChecks: Check[] = [
  check("hotfix update exits cleanly", update.status === 0, `status=${update.status ?? "null"} ${update.stderr.split(/\r?\n/).slice(-4).join(" | ")}`),
  check("backup root created", backupRoot.length > 0, backupRoot || "missing"),
  check("AGENTS.md backup captured old content", read(join(backupRoot, "AGENTS.md")) === sentinels.agents, join(backupRoot, "AGENTS.md")),
  check("pai.ts backup captured old content", read(join(backupRoot, "PAI", "TOOLS", "pai.ts")) === sentinels.paiTool, join(backupRoot, "PAI", "TOOLS", "pai.ts")),
  check("RepeatDetection backup captured old content", read(join(backupRoot, "hooks", "RepeatDetection.hook.ts")) === sentinels.repeatHook, join(backupRoot, "hooks", "RepeatDetection.hook.ts")),
  check("PromptGuard backup captured old content", read(join(backupRoot, "hooks", "PromptGuard.hook.ts")) === sentinels.promptGuardHook, join(backupRoot, "hooks", "PromptGuard.hook.ts")),
  check("pai.ts updated from release", updatedPaiTool.includes("Run PAI runtime diagnostics"), join(installRoot, "PAI", "TOOLS", "pai.ts")),
  check("hotfix preserves linked PAI/TOOLS directory", Boolean(linkedToolsStats?.isSymbolicLink()) && read(join(installRoot, "PAI", "TOOLS", "ExtraTool.ts")) === "LINKED_EXTRA_TOOL_SENTINEL", join(installRoot, "PAI", "TOOLS")),
  check("RepeatDetection updated from release", updatedRepeatHook.includes("Continue by addressing the newest request directly"), join(installRoot, "hooks", "RepeatDetection.hook.ts")),
  check("PromptGuard updated from release", updatedPromptGuardHook.includes("process.exitCode = 2"), join(installRoot, "hooks", "PromptGuard.hook.ts")),
  check("MemoryDelete smoke installed", existsSync(join(installRoot, "PAI", "TOOLS", "MemoryDeleteSmokeTest.ts")), join(installRoot, "PAI", "TOOLS", "MemoryDeleteSmokeTest.ts")),
  check("Framework command smoke installed", existsSync(join(installRoot, "PAI", "TOOLS", "FrameworkCommandResolutionSmokeTest.ts")), join(installRoot, "PAI", "TOOLS", "FrameworkCommandResolutionSmokeTest.ts")),
  check("Framework launch smoke installed", existsSync(join(installRoot, "PAI", "TOOLS", "FrameworkLaunchCwdSmokeTest.ts")), join(installRoot, "PAI", "TOOLS", "FrameworkLaunchCwdSmokeTest.ts")),
  check("hooks.json regenerated with PromptProcessing", updatedHooksJson.includes("PromptProcessing.hook.ts"), join(installRoot, "hooks.json")),
  check("PromptProcessing timeout leaves adapter headroom", updatedHooksJson.includes('"timeout": 40') && updatedHooksJson.includes("--timeout-ms") && updatedHooksJson.includes("35000"), join(installRoot, "hooks.json")),
  check("hooks.json regenerated with ISA sync hooks", updatedHooksJson.includes("ISASync.hook.ts") && updatedHooksJson.includes("CheckpointPerISC.hook.ts"), join(installRoot, "hooks.json")),
  check("hooks.json Windows commands are encoded", updatedHooksJson.includes("-EncodedCommand"), join(installRoot, "hooks.json")),
  check("hooks.json ignores stale env PAI_DATA_DIR", hookDataDirs.length > 0 && hookDataDirs.every((value) => value.endsWith(expectedHookDataSuffix) && !value.includes(staleHookDataSegment)), JSON.stringify(hookDataDirs)),
  check("updater refreshes PAI environment variables", process.platform !== "win32" || update.stdout.includes("Updated PAI environment variables at Process scope"), "process-scope user env test"),
  check("hotfix repairs PowerShell all-host profile", process.platform !== "win32" || (powerShellAllHostsProfileText.includes("Initialize-PAIEnvironment") && powerShellAllHostsProfileText.includes("PAI_DIR")), powerShellAllHostsProfile),
  check("hotfix repairs PowerShell profile PAI_DIR", process.platform !== "win32" || (powerShellProfileText.includes("Initialize-PAIEnvironment") && powerShellProfileText.includes("PAI_DIR")), powerShellProfile),
  check("hotfix repairs WindowsPowerShell all-host profile", process.platform !== "win32" || (windowsPowerShellAllHostsProfileText.includes("Initialize-PAIEnvironment") && windowsPowerShellAllHostsProfileText.includes("PAI_DIR")), windowsPowerShellAllHostsProfile),
  check("hotfix repairs WindowsPowerShell profile PAI_DIR", process.platform !== "win32" || (windowsPowerShellProfileText.includes("Initialize-PAIEnvironment") && windowsPowerShellProfileText.includes("PAI_DIR")), windowsPowerShellProfile),
  check("hotfix repairs OneDrive PowerShell profiles", process.platform !== "win32" || profileTexts.slice(4).every((text) => text.includes("Initialize-PAIEnvironment") && text.includes("PAI_DIR")), oneDriveRoot),
  check("PowerShell profiles avoid stale smoke roots", process.platform !== "win32" || profileTexts.every((text) => !text.includes(staleEnvDataDir) && !text.includes(join(root, "deleted-codex"))), "profile bootstrap paths"),
  check("PowerShell bootstrap repairs stale PAI_DIR", process.platform !== "win32" || powerShellAllHostsProfileText.includes("-not (Test-Path -LiteralPath $env:PAI_DIR)"), powerShellAllHostsProfile),
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
