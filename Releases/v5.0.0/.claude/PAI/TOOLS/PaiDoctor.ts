#!/usr/bin/env bun
/**
 * PaiDoctor
 *
 * Runtime confidence check for a live PAI install.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

type Check = {
  name: string;
  passed: boolean;
  detail: string;
  critical?: boolean;
};

const home = homedir();
const frameworkRoot = process.env.PAI_FRAMEWORK_DIR || process.env.CODEX_HOME || join(home, ".codex");
const paiDir = process.env.PAI_DIR || join(frameworkRoot, "PAI");
const dataDir = process.env.PAI_DATA_DIR || join(home, ".pai");
const toolsDir = import.meta.dir;

function ok(name: string, passed: boolean, detail: string, critical = true): Check {
  return { name, passed, detail, critical };
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function runBunTool(name: string): Check {
  const path = join(toolsDir, name);
  const res = spawnSync(process.execPath, [path], {
    encoding: "utf-8",
    timeout: name === "CodexRealSessionHookProof.ts" ? 120_000 : 60_000,
    env: {
      ...process.env,
      PAI_DIR: paiDir,
      PAI_DATA_DIR: dataDir,
      PAI_FRAMEWORK: "codex",
      PAI_FRAMEWORK_DIR: frameworkRoot,
      PAI_SETTINGS_PATH: join(frameworkRoot, "settings.json"),
      PAI_CONFIG_DIR: process.env.PAI_CONFIG_DIR || join(home, ".config", "PAI"),
    },
  });
  const output = `${res.stdout || ""}${res.stderr || ""}`.trim().split("\n").slice(-3).join(" | ");
  return ok(name.replace(/\.ts$/, ""), res.status === 0, output || `status=${res.status ?? "null"}`);
}

async function pulseCheck(path: string, init?: RequestInit): Promise<Check> {
  try {
    const res = await fetch(`http://localhost:31337${path}`, {
      ...init,
      signal: AbortSignal.timeout(3000),
    });
    return ok(`Pulse ${path}`, res.ok, `HTTP ${res.status}`);
  } catch (err) {
    return ok(`Pulse ${path}`, false, err instanceof Error ? err.message : String(err));
  }
}

function systemdPulseChecks(): Check[] {
  if (process.platform === "darwin" || process.platform === "win32") return [];
  const status = spawnSync("systemctl", ["--user", "is-active", "com.pai.pulse.service"], { encoding: "utf-8", timeout: 5000 });
  const enabled = spawnSync("systemctl", ["--user", "is-enabled", "com.pai.pulse.service"], { encoding: "utf-8", timeout: 5000 });
  return [
    ok("Pulse systemd service active", status.status === 0, (status.stdout || status.stderr || "").trim() || `status=${status.status}`),
    ok("Pulse systemd service enabled", enabled.status === 0, (enabled.stdout || enabled.stderr || "").trim() || `status=${enabled.status}`),
  ];
}

function optionalSecretChecks(): Check[] {
  const envFiles = [join(frameworkRoot, ".env"), join(dataDir, "USER", "Config", "PAI_CONFIG.yaml")];
  const envText = envFiles.filter(existsSync).map((path) => readFileSync(path, "utf-8")).join("\n");
  return [
    ok("Optional ElevenLabs key configured", /ELEVENLABS_API_KEY\s*=\s*[^#\s]+/.test(envText) || Boolean(process.env.ELEVENLABS_API_KEY), "needed for actual TTS audio", false),
    ok("Optional Telegram bot configured", /TELEGRAM_BOT_TOKEN\s*=\s*[^#\s]+/.test(envText) || Boolean(process.env.TELEGRAM_BOT_TOKEN), "needed for Telegram chat/alerts", false),
    ok("Optional Bright Data token configured", Boolean(process.env.API_TOKEN), "needed for Bright Data MCP", false),
    ok("Optional Apify token configured", Boolean(process.env.APIFY_TOKEN), "needed for Apify MCP", false),
  ];
}

async function main() {
  const frameworkState = readJson(join(dataDir, "framework.json"));
  const configToml = existsSync(join(frameworkRoot, "config.toml")) ? readFileSync(join(frameworkRoot, "config.toml"), "utf-8") : "";
  const hooksJson = existsSync(join(frameworkRoot, "hooks.json")) ? readFileSync(join(frameworkRoot, "hooks.json"), "utf-8") : "";
  const mcpDir = join(frameworkRoot, "MCPs");

  const checks: Check[] = [
    ok("Active framework is Codex", frameworkState?.active === "codex", join(dataDir, "framework.json")),
    ok("Codex root exists", existsSync(frameworkRoot), frameworkRoot),
    ok("AGENTS.md exists", existsSync(join(frameworkRoot, "AGENTS.md")), join(frameworkRoot, "AGENTS.md")),
    ok("RTK.md exists", existsSync(join(frameworkRoot, "RTK.md")), join(frameworkRoot, "RTK.md")),
    ok("config.toml has PAI root block", configToml.includes("BEGIN PAI MANAGED ROOT CONFIG"), join(frameworkRoot, "config.toml")),
    ok("config.toml has MCP block", configToml.includes("BEGIN PAI MANAGED MCP CONFIG"), join(frameworkRoot, "config.toml")),
    ok("hooks.json has FrameworkHookAdapter", hooksJson.includes("FrameworkHookAdapter.ts"), join(frameworkRoot, "hooks.json")),
    ok("MCP profiles present", existsSync(mcpDir) && readdirSync(mcpDir).some((file) => file.endsWith(".mcp.json")), mcpDir),
    ok("Shared PAI data exists", existsSync(dataDir), dataDir),
    ...systemdPulseChecks(),
    await pulseCheck("/health"),
    await pulseCheck("/voice/health"),
    await pulseCheck("/assistant/health"),
    await pulseCheck("/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "PAI doctor check", voice_enabled: false }),
    }),
    runBunTool("CodexPaiSecuritySmokeTest.ts"),
    runBunTool("HookSharedPathSmokeTest.ts"),
    runBunTool("CodexHookTriggerSmokeTest.ts"),
    runBunTool("CodexRealSessionHookProof.ts"),
    runBunTool("CodexFreshInstallSmokeTest.ts"),
    ...optionalSecretChecks(),
  ];

  let failedCritical = 0;
  let warnings = 0;
  for (const check of checks) {
    const marker = check.passed ? "PASS" : check.critical === false ? "WARN" : "FAIL";
    console.log(`${marker} ${check.name} - ${check.detail}`);
    if (!check.passed && check.critical === false) warnings++;
    else if (!check.passed) failedCritical++;
  }

  console.log("");
  if (failedCritical > 0) {
    console.error(`PAI doctor failed: ${failedCritical} critical check(s), ${warnings} warning(s).`);
    process.exit(1);
  }
  console.log(`PAI doctor passed: ${checks.length - warnings} critical check(s), ${warnings} optional reminder(s).`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
