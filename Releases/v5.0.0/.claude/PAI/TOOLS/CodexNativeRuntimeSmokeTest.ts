#!/usr/bin/env bun
/**
 * CodexNativeRuntimeSmokeTest
 *
 * Source-level regression checks for the product-critical native Codex paths:
 * Algorithm execution, Pulse AI jobs, Pulse chat modules, and Pulse static build.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

type Check = {
  name: string;
  passed: boolean;
  detail: string;
};

const releaseRoot = resolve(import.meta.dir, "..", "..");
const paiRoot = join(releaseRoot, "PAI");
const checks: Check[] = [];

function read(path: string): string {
  return readFileSync(path, "utf-8");
}

function check(name: string, passed: boolean, detail = ""): void {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
}

function walkTextFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".next", "cache"].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkTextFiles(path, acc);
    else if (/\.(ts|tsx|js|html|txt|json|md|css)$/.test(entry.name)) acc.push(path);
  }
  return acc;
}

const frameworkAgent = read(join(paiRoot, "TOOLS", "lib", "framework-agent.ts"));
const algorithm = read(join(paiRoot, "TOOLS", "algorithm.ts"));
const paiCli = read(join(paiRoot, "TOOLS", "pai.ts"));
const inferenceTool = read(join(paiRoot, "TOOLS", "Inference.ts"));
const transcriptParser = read(join(paiRoot, "TOOLS", "TranscriptParser.ts"));
const pulseLib = read(join(paiRoot, "PULSE", "lib.ts"));
const pulse = read(join(paiRoot, "PULSE", "pulse.ts"));
const githubWork = read(join(paiRoot, "PULSE", "checks", "github-work.ts"));
const telegram = read(join(paiRoot, "PULSE", "modules", "telegram.ts"));
const imessage = read(join(paiRoot, "PULSE", "modules", "imessage.ts"));
const pulseToml = read(join(paiRoot, "PULSE", "PULSE.toml"));
const pulsePackage = read(join(paiRoot, "PULSE", "package.json"));
const setup = read(join(paiRoot, "PULSE", "setup.ts"));
const nextConfig = read(join(paiRoot, "PULSE", "Observability", "next.config.ts"));
const claudeAgentSdkPackage = ["@anthropic-ai", "claude-agent-sdk"].join("/");

check(
  "framework agent launches Codex exec with workspace-write",
  frameworkAgent.includes('"codex"') &&
    frameworkAgent.includes('"exec"') &&
    frameworkAgent.includes('"--sandbox"') &&
    frameworkAgent.includes('"workspace-write"') &&
    frameworkAgent.indexOf('if (framework === "codex")') < frameworkAgent.indexOf('Bun.which("claude")'),
  "PAI/TOOLS/lib/framework-agent.ts",
);

check(
  "Inference chooses Codex before Claude fallback",
  inferenceTool.includes('const framework = getActiveFramework()') &&
    inferenceTool.includes('const useCodex = framework === "codex"') &&
    inferenceTool.indexOf('if (useCodex)') < inferenceTool.indexOf("spawn('claude'"),
  "PAI/TOOLS/Inference.ts",
);

check(
  "Algorithm uses framework agent launcher",
  algorithm.includes("buildFrameworkAgentCommand") &&
    !/spawnSync\(\s*["']claude["']/.test(algorithm) &&
    !/spawn\(\s*["']claude["']/.test(algorithm) &&
    !/Bun\.spawn\(\s*\[\s*["']claude["']/.test(algorithm) &&
    !algorithm.includes("--bare"),
  "loop, parallel, interactive, and ideate modes",
);

check(
  "Pulse cron jobs use active AI launcher",
  pulseLib.includes("export async function spawnAI") &&
    pulseLib.includes("export const spawnClaude = spawnAI") &&
    pulse.includes("spawnAI") &&
    !pulse.includes("spawnClaude"),
  "legacy alias remains in lib only",
);

check(
  "Pulse worker uses framework agent launcher",
  githubWork.includes("runFrameworkAgent") &&
    !githubWork.includes('Bun.which("claude")') &&
    !githubWork.includes("claudePath") &&
    !githubWork.includes("claude --print"),
  "PAI/PULSE/checks/github-work.ts",
);

check(
  "Pulse chat modules route from active framework state",
    telegram.includes("await inference({") &&
    imessage.includes("await inference({") &&
    !telegram.includes(claudeAgentSdkPackage) &&
    !imessage.includes(claudeAgentSdkPackage) &&
    !pulsePackage.includes(claudeAgentSdkPackage),
  "Telegram and iMessage use PAI Inference, not Claude Agent SDK",
);

check(
  "PAI one-shot prompt uses Codex exec stdin",
  paiCli.includes('"exec", "--sandbox", "workspace-write"') &&
    paiCli.includes('new Blob([prompt])') &&
    !paiCli.includes('["claude", "-p", prompt]'),
  "PAI/TOOLS/pai.ts",
);

check(
  "Stop transcript parser understands Codex response_item events",
  transcriptParser.includes("entry?.type === 'response_item'") &&
    transcriptParser.includes("entry.payload?.type === 'message'") &&
    transcriptParser.includes("entry.payload?.type === 'function_call'") &&
    transcriptParser.includes("requestuserinput"),
  "PAI/TOOLS/TranscriptParser.ts",
);

check(
  "Pulse config teaches ai job type",
  pulseToml.includes('type = "ai"') &&
    !pulseToml.includes('type = "claude"') &&
    setup.includes('type = "ai"') &&
    !setup.includes('type = "claude"'),
  "legacy type remains accepted by loader",
);

check(
  "Pulse static export pins tracing root",
  nextConfig.includes("outputFileTracingRoot") &&
    nextConfig.includes("pai-pulse-static") &&
    !nextConfig.includes("Date.now()"),
  "PAI/PULSE/Observability/next.config.ts",
);

const outFiles = walkTextFiles(join(paiRoot, "PULSE", "Observability", "out"));
const staleOut = outFiles.filter((path) => read(path).includes("~/.claude/PAI/USER"));
check(
  "Pulse static export has no stale Claude USER path",
  staleOut.length === 0,
  staleOut.length ? staleOut.slice(0, 8).join("\n") : `${outFiles.length} exported text files scanned`,
);

check(
  "Pulse static export includes referenced logo",
  existsSync(join(paiRoot, "PULSE", "Observability", "public", "pai-logo.png")) &&
    existsSync(join(paiRoot, "PULSE", "Observability", "out", "pai-logo.png")),
  "public/pai-logo.png and out/pai-logo.png",
);

const failed = checks.filter((item) => !item.passed);
if (failed.length > 0) {
  console.error(`\nCodex native runtime smoke failed: ${failed.length} check(s).`);
  process.exit(1);
}

console.log("\nAll Codex native runtime checks passed.");
