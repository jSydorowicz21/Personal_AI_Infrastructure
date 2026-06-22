#!/usr/bin/env bun
/**
 * CodexBranchValidation
 *
 * CI entrypoint for the Codex PAI release branch. Keeps branch validation
 * reproducible locally and in GitHub Actions.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

type Check = {
  name: string;
  passed: boolean;
  detail: string;
};

const releaseRoot = resolve(import.meta.dir, "..", "..");
const repoRoot = resolve(releaseRoot, "..", "..", "..");
const tempRoot = mkdtempSync(join(tmpdir(), "pai-codex-branch-ci-"));
const checks: Check[] = [];

function check(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} ${name} - ${detail}`);
}

function run(name: string, command: string, args: string[], options: { cwd?: string; env?: Record<string, string>; timeout?: number } = {}): void {
  const result = spawnSync(command, args, {
    cwd: options.cwd || releaseRoot,
    env: { ...process.env, ...options.env },
    encoding: "utf-8",
    timeout: options.timeout || 120_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  const detail = result.status === 0
    ? output.split(/\r?\n/).slice(-1)[0] || `${command} ${args.join(" ")}`
    : `status=${result.status ?? "null"} signal=${result.signal ?? ""}\n${output.split(/\r?\n/).slice(-80).join("\n")}`;
  check(name, result.status === 0, detail);
}

function walk(dir: string, predicate: (path: string) => boolean, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if ([".git", "node_modules", ".next", "out", "dist", "coverage"].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, predicate, acc);
    else if (predicate(path)) acc.push(path);
  }
  return acc;
}

function validateJson(): void {
  const jsonFiles = walk(repoRoot, (path) => path.endsWith(".json") || path.endsWith(".mcp.json"));
  const failures: string[] = [];
  for (const path of jsonFiles) {
    try {
      const raw = readFileSync(path, "utf-8");
      const text = /(^|[/\\])tsconfig[^/\\]*\.json$/.test(path) ? stripJsonComments(raw) : raw;
      JSON.parse(text);
    } catch (err) {
      failures.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  check("JSON validation", failures.length === 0, failures.length === 0 ? `${jsonFiles.length} JSON files parsed` : failures.slice(0, 12).join("\n"));
}

function stripJsonComments(text: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      output += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }
    output += char;
  }
  return output;
}

function validateReadmeUrls(): void {
  const readmes = [
    join(repoRoot, "README.md"),
    join(repoRoot, "Releases", "v5.0.0", "README.md"),
    join(releaseRoot, "README.md"),
  ];
  const stalePatterns = [
    "pai-codex-windows-installer",
    "raw.githubusercontent.com/jSydorowicz21/Personal_AI_Infrastructure",
    "github.com/jSydorowicz21/Personal_AI_Infrastructure",
  ];
  const failures: string[] = [];
  for (const path of readmes) {
    const text = existsSync(path) ? readFileSync(path, "utf-8") : "";
    for (const pattern of stalePatterns) {
      if (text.includes(pattern)) failures.push(`${path}: ${pattern}`);
    }
  }
  check("README stale URL scan", failures.length === 0, failures.length === 0 ? "no known stale fork/branch URLs" : failures.join("\n"));
}

function validateDoctorDiscoverability(): void {
  const files = [
    join(repoRoot, "README.md"),
    join(releaseRoot, "README.md"),
    join(releaseRoot, "PAI", "PAI-Install", "README.md"),
    join(releaseRoot, "PAI", "TOOLS", "pai.ts"),
  ];
  const missing = files.filter((path) => !readFileSync(path, "utf-8").includes("k doctor"));
  run("k help documents doctor", "bun", ["PAI/TOOLS/pai.ts", "help"]);
  check("doctor docs discoverability", missing.length === 0, missing.length === 0 ? "k doctor appears in CLI help and docs" : missing.join("\n"));
}

function validateHotfixDryRun(): void {
  const installRoot = join(tempRoot, "install-root");
  const home = join(tempRoot, "home");
  const paiData = join(home, ".pai");
  mkdirSync(installRoot, { recursive: true });
  mkdirSync(paiData, { recursive: true });
  run("hotfix dry-run", "bash", [
    join(releaseRoot, "update-installed.sh"),
    "--framework", "codex",
    "--install-root", installRoot,
    "--source-dir", repoRoot,
    "--no-pull",
    "--dry-run",
  ], {
    cwd: repoRoot,
    env: {
      HOME: home,
      CODEX_HOME: installRoot,
      PAI_DATA_DIR: paiData,
    },
  });
}

function main(): void {
  try {
    run("Bun build critical TypeScript", "bun", [
      "build",
      "PAI/PAI-Install/main.ts",
      "PAI/TOOLS/pai.ts",
      "PAI/TOOLS/PaiDoctor.ts",
      "PAI/TOOLS/CodexFreshInstallSmokeTest.ts",
      "PAI/TOOLS/InstallerCodexSmokeTest.ts",
      "PAI/TOOLS/CodexPaiSecuritySmokeTest.ts",
      "PAI/TOOLS/HookSharedPathSmokeTest.ts",
      "PAI/TOOLS/StartupSelfCheckSmokeTest.ts",
      "PAI/TOOLS/RepeatDetectionSmokeTest.ts",
      "PAI/TOOLS/CodexHookContractSmokeTest.ts",
      "PAI/TOOLS/HotfixUpdateRollbackSmokeTest.ts",
      "--target=bun",
      "--outdir",
      join(tempRoot, "build"),
    ]);

    validateJson();

    run("Codex security smoke", "bun", ["PAI/TOOLS/CodexPaiSecuritySmokeTest.ts"]);
    run("Hook shared-path smoke", "bun", ["PAI/TOOLS/HookSharedPathSmokeTest.ts"]);
    run("Startup self-check smoke", "bun", ["PAI/TOOLS/StartupSelfCheckSmokeTest.ts"], {
      env: {
        PAI_BRANCH_CI: "1",
        PAI_FRAMEWORK_DIR: releaseRoot,
        PAI_DIR: join(releaseRoot, "PAI"),
        PAI_DATA_DIR: join(tempRoot, "pai-data"),
      },
    });
    run("Repeat detection smoke", "bun", ["PAI/TOOLS/RepeatDetectionSmokeTest.ts"], {
      env: {
        PAI_FRAMEWORK_DIR: releaseRoot,
        PAI_DIR: join(releaseRoot, "PAI"),
        PAI_DATA_DIR: join(tempRoot, "pai-data-repeat"),
      },
    });
    run("Codex hook contract smoke", "bun", ["PAI/TOOLS/CodexHookContractSmokeTest.ts"], {
      env: {
        PAI_FRAMEWORK_DIR: releaseRoot,
        PAI_DIR: join(releaseRoot, "PAI"),
        PAI_DATA_DIR: join(tempRoot, "pai-data-hook-contract"),
      },
    });
    run("Hotfix update/rollback smoke", "bun", ["PAI/TOOLS/HotfixUpdateRollbackSmokeTest.ts"]);
    run("Codex fresh-install smoke", "bun", ["PAI/TOOLS/CodexFreshInstallSmokeTest.ts"]);
    run("Codex installer smoke", "bun", ["PAI/TOOLS/InstallerCodexSmokeTest.ts"]);

    validateHotfixDryRun();
    validateReadmeUrls();
    validateDoctorDiscoverability();

    const failed = checks.filter((item) => !item.passed);
    if (failed.length > 0) {
      console.error(`\nPAI Codex branch validation failed: ${failed.length} check(s).`);
      process.exit(1);
    }
    console.log(`\nPAI Codex branch validation passed: ${checks.length} check(s).`);
  } finally {
    const resolved = resolve(tempRoot);
    if (dirname(resolved) === resolve(tmpdir()) && resolved.includes("pai-codex-branch-ci-")) {
      rmSync(resolved, { recursive: true, force: true });
    }
  }
}

main();
