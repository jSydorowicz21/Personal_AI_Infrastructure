#!/usr/bin/env bun
/**
 * PaiDoctorSmokeTest
 *
 * Source-level guards for provider-native doctor wiring.
 * Runtime doctor checks talk to live Pulse and can run expensive provider
 * probes, so branch CI keeps the parity contract focused and deterministic.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

type Check = {
  name: string;
  passed: boolean;
  detail: string;
};

const doctor = readFileSync(join(import.meta.dir, "PaiDoctor.ts"), "utf-8");
const checks: Check[] = [];

function check(name: string, passed: boolean, detail = ""): void {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
}

check(
  "doctor resolves active framework",
  doctor.includes("function activeFrameworkFrom") &&
    doctor.includes("normalizeFramework(process.env.PAI_FRAMEWORK)") &&
    doctor.includes("const activeFramework = activeFrameworkFrom(frameworkState)"),
  "framework.json/env selection",
);

check(
  "doctor does not force Codex into child smoke tools",
  !doctor.includes('PAI_FRAMEWORK: "codex"') &&
    doctor.includes("PAI_FRAMEWORK: framework"),
  "runBunTool uses selected framework",
);

check(
  "doctor has Claude-native checks",
  doctor.includes('framework === "claude"') &&
    doctor.includes("Claude settings.json exists") &&
    doctor.includes("Claude hooks invoke FrameworkHookAdapter") &&
    doctor.includes('return framework === "claude" ? "CLAUDE.md" : "AGENTS.md"'),
  "settings.json/CLAUDE.md path",
);

check(
  "doctor has Codex-native checks",
  doctor.includes('framework === "codex"') &&
    doctor.includes("Codex config.toml has PAI root block") &&
    doctor.includes("Codex hooks.json has runnable hook commands") &&
    doctor.includes("CodexRealSessionHookProof.ts"),
  "config.toml/hooks.json/Codex proof",
);

check(
  "doctor has OpenCode-native checks",
  doctor.includes('framework === "opencode"') &&
    doctor.includes("OpenCode opencode.json exists") &&
    doctor.includes("OpenCode plugin includes SessionEndDispatcher") &&
    doctor.includes("OpenCodeFrameworkAgentExecutionSmokeTest.ts"),
  "opencode.json/plugin",
);

check(
  "doctor hides Windows smoke child windows",
  doctor.includes("windowsHide: true"),
  "spawnSync options",
);

const failed = checks.filter((item) => !item.passed);
if (failed.length > 0) {
  console.error(`\nPaiDoctor smoke failed: ${failed.length} check(s).`);
  process.exit(1);
}

console.log("\nAll PaiDoctor smoke checks passed.");
