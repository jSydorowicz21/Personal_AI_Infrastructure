#!/usr/bin/env bun
/**
 * CodexFreshInstallSmokeTest
 *
 * Exercises the real installer repository/configuration path against a
 * temporary HOME/CODEX_HOME/PAI_DATA_DIR. This catches packaging regressions
 * without touching the user's live framework install.
 */

import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

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

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf-8"));
}

const keep = process.argv.includes("--keep");
const root = join(tmpdir(), `pai-codex-fresh-install-${Date.now()}-${Math.random().toString(16).slice(2)}`);
const home = join(root, "home");
const codexHome = join(home, ".codex");
const dataDir = join(home, ".pai");
const configDir = join(home, ".config", "PAI");
const shellProfile = join(home, ".bashrc");
const releaseRoot = resolve(import.meta.dir, "..", "..");

process.env.HOME = home;
process.env.CODEX_HOME = codexHome;
process.env.PAI_DATA_DIR = dataDir;
process.env.PAI_CONFIG_DIR = configDir;
process.env.PAI_FRAMEWORK = "codex";
process.env.PAI_BUNDLE_DIR = releaseRoot;
process.env.PAI_SHELL_PROFILE = shellProfile;
process.env.SHELL = "/bin/bash";

const { createFreshState, completeStep } = await import("../PAI-Install/engine/state.ts");
const { runSystemDetect, runRepository, runConfiguration } = await import("../PAI-Install/engine/actions.ts");

const events: string[] = [];
const emit = async (event: any) => {
  if (event?.content) events.push(event.content);
};

const state = createFreshState("cli");
state.collected.framework = "codex";
state.collected.principalName = "Smoke User";
state.collected.aiName = "SMOKE";
state.collected.catchphrase = "Smoke ready";
state.collected.scanConsent = "no";
state.collected.timezone = "America/Chicago";

try {
  await runSystemDetect(state, emit);
  completeStep(state, "system-detect");
  await runRepository(state, emit);
  completeStep(state, "repository");
  await runConfiguration(state, emit);
  completeStep(state, "configuration");

  const configToml = existsSync(join(codexHome, "config.toml")) ? readFileSync(join(codexHome, "config.toml"), "utf-8") : "";
  const hooksJson = existsSync(join(codexHome, "hooks.json")) ? readFileSync(join(codexHome, "hooks.json"), "utf-8") : "";
  const agentsMd = existsSync(join(codexHome, "AGENTS.md")) ? readFileSync(join(codexHome, "AGENTS.md"), "utf-8") : "";
  const profile = existsSync(shellProfile) ? readFileSync(shellProfile, "utf-8") : "";
  const frameworkState = existsSync(join(dataDir, "framework.json")) ? readJson(join(dataDir, "framework.json")) : {};

  const checks: Check[] = [
    check("Codex home created", existsSync(codexHome), codexHome),
    check("AGENTS.md generated", agentsMd.includes("# AGENTS.md") || agentsMd.includes("PAI"), join(codexHome, "AGENTS.md")),
    check("RTK.md generated", existsSync(join(codexHome, "RTK.md")), join(codexHome, "RTK.md")),
    check("config.toml has PAI root block", configToml.includes("BEGIN PAI MANAGED ROOT CONFIG"), join(codexHome, "config.toml")),
    check("config.toml supports AGENTS/RTK fallback", configToml.includes("AGENTS.md") && configToml.includes("RTK.md"), "project_doc_fallback_filenames"),
    check("hooks.json generated", hooksJson.includes("FrameworkHookAdapter.ts"), join(codexHome, "hooks.json")),
    check("startup self-check hook generated", hooksJson.includes("StartupSelfCheck.hook.ts"), join(codexHome, "hooks.json")),
    check("MCP profiles packaged", existsSync(join(codexHome, "MCPs", "dev-work.mcp.json")), join(codexHome, "MCPs", "dev-work.mcp.json")),
    check("MCP profile JSON parses", readJson(join(codexHome, "MCPs", "dev-work.mcp.json"))?.mcpServers?.shadcn?.command === "bunx", "dev-work.mcp.json"),
    check("framework state points to Codex", frameworkState.active === "codex" && frameworkState.root === codexHome, join(dataDir, "framework.json")),
    check("shell profile isolated to temp HOME", existsSync(shellProfile), shellProfile),
    check("shell k alias points to temp Codex", profile.includes(`bun ${JSON.stringify(join(codexHome, "PAI", "TOOLS", "pai.ts"))}`), shellProfile),
    check("shell pai alias points to temp data", profile.includes(`PAI_DATA_DIR=${JSON.stringify(dataDir)}`), shellProfile),
    check("shared MEMORY link exists", existsSync(join(codexHome, "PAI", "MEMORY")) && lstatSync(join(codexHome, "PAI", "MEMORY")).isSymbolicLink(), join(codexHome, "PAI", "MEMORY")),
    check("shared USER link exists", existsSync(join(codexHome, "PAI", "USER")) && lstatSync(join(codexHome, "PAI", "USER")).isSymbolicLink(), join(codexHome, "PAI", "USER")),
  ];

  print(checks);
  const failed = checks.filter((item) => !item.passed);
  if (failed.length > 0) {
    console.error(`\n${failed.length} Codex fresh-install smoke check(s) failed.`);
    process.exit(1);
  }

  console.log("\nAll Codex fresh-install smoke checks passed.");
} finally {
  if (keep) {
    console.log(`\nKept smoke root: ${root}`);
  } else {
    rmSync(root, { recursive: true, force: true });
  }
}
