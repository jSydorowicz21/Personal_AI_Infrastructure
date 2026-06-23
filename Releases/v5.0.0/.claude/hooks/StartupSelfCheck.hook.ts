#!/usr/bin/env bun
/**
 * StartupSelfCheck.hook.ts
 *
 * Lightweight startup reminder for doctor-critical PAI runtime failures. This
 * intentionally does not run the full doctor: no Codex sessions, no installer
 * smoke tests, no provider auth checks. It only checks cheap local invariants
 * and fast Pulse health routes, then prints a concise reminder if anything is
 * broken.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getDataDir, getFrameworkDir } from "./lib/paths";
import { isSubagentSession } from "./lib/session";

type Check = {
  name: string;
  passed: boolean;
  detail: string;
};

function check(name: string, passed: boolean, detail: string): Check {
  return { name, passed, detail };
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

async function pulseCheck(path: string): Promise<Check> {
  try {
    const res = await fetch(`http://localhost:31337${path}`, {
      signal: AbortSignal.timeout(900),
    });
    return check(`Pulse ${path}`, res.ok, `HTTP ${res.status}`);
  } catch (err) {
    return check(`Pulse ${path}`, false, err instanceof Error ? err.message : String(err));
  }
}

async function main() {
  if (isSubagentSession()) return;

  const frameworkRoot = getFrameworkDir();
  const dataDir = getDataDir();
  const configTomlPath = join(frameworkRoot, "config.toml");
  const hooksJsonPath = join(frameworkRoot, "hooks.json");
  const mcpDir = join(frameworkRoot, "MCPs");
  const configToml = readText(configTomlPath);
  const hooksJson = readText(hooksJsonPath);

  const checks: Check[] = [
    check("AGENTS.md exists", existsSync(join(frameworkRoot, "AGENTS.md")), join(frameworkRoot, "AGENTS.md")),
    check("RTK.md exists", existsSync(join(frameworkRoot, "RTK.md")), join(frameworkRoot, "RTK.md")),
    check("config.toml has PAI root block", configToml.includes("BEGIN PAI MANAGED ROOT CONFIG"), configTomlPath),
    check("config.toml has MCP block", configToml.includes("BEGIN PAI MANAGED MCP CONFIG"), configTomlPath),
    check("hooks.json has FrameworkHookAdapter", hooksJson.includes("FrameworkHookAdapter.ts"), hooksJsonPath),
    check("hooks.json has StartupSelfCheck", hooksJson.includes("StartupSelfCheck.hook.ts"), hooksJsonPath),
    check("MCP profiles present", existsSync(mcpDir) && readdirSync(mcpDir).some((file) => file.endsWith(".mcp.json")), mcpDir),
    check("Shared PAI data exists", existsSync(dataDir), dataDir),
    await pulseCheck("/health"),
    await pulseCheck("/voice/health"),
    await pulseCheck("/assistant/health"),
  ];

  const failures = checks.filter((item) => !item.passed);
  if (failures.length === 0) return;

  const lines = failures
    .slice(0, 6)
    .map((item) => `- ${item.name}: ${item.detail}`);
  const suffix = failures.length > lines.length ? `\n- ...and ${failures.length - lines.length} more` : "";

  console.log([
    "⚠️ PAI startup self-check found doctor-critical issue(s):",
    ...lines,
    `${suffix}\nRun \`k doctor\` for full diagnostics.`,
  ].join("\n"));
}

main().catch(() => {
  // Startup self-check is advisory. Never block session startup.
  process.exit(0);
});
