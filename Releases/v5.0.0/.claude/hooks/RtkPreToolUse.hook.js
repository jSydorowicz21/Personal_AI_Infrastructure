#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const { appendFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");
const { homedir } = require("node:os");

const DEFAULT_RTK_REWRITE_TIMEOUT_MS = 1500;

function rewriteTimeoutMs() {
  const raw = Number(process.env.PAI_RTK_REWRITE_TIMEOUT_MS || "");
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RTK_REWRITE_TIMEOUT_MS;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function getCommand(payload) {
  const input = payload?.tool_input ?? payload?.toolInput ?? payload?.input;
  if (!input || typeof input.command !== "string") {
    return null;
  }
  return { input, command: input.command };
}

function dataDir() {
  return process.env.PAI_DATA_DIR || join(process.env.HOME || process.env.USERPROFILE || homedir(), ".pai");
}

function recordMiss(reason, command, detail = "") {
  try {
    const dir = join(dataDir(), "MEMORY", "OBSERVABILITY");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "rtk-hook-misses.jsonl"), JSON.stringify({
      ts: new Date().toISOString(),
      reason,
      detail,
      command: command.length > 240 ? `${command.slice(0, 237)}...` : command,
    }) + "\n");
  } catch {
    // Observability must never break hook execution.
  }
}

function rewriteCommand(command) {
  const result = spawnSync("rtk", ["rewrite", command], {
    encoding: "utf8",
    windowsHide: true,
    timeout: rewriteTimeoutMs(),
  });

  if (result.error) {
    recordMiss("rtk_unavailable_or_timeout", command, result.error.message);
    if (process.env.PAI_HOOK_DEBUG === "1") {
      process.stderr.write(`[RtkPreToolUse] rtk rewrite failed: ${result.error.message}\n`);
    }
    return null;
  }

  const rewritten = (result.stdout || "").trim();
  if (!rewritten || rewritten === command.trim()) {
    recordMiss("not_rewritable", command);
    return null;
  }

  if (!rewritten.toLowerCase().startsWith("rtk ")) {
    recordMiss("non_rtk_rewrite", command, rewritten);
    return null;
  }

  return rewritten;
}

function isRtkCommand(command) {
  return /^\s*rtk(\.exe)?(\s|$)/i.test(command);
}

function emitUpdatedInput(payload, input, rewrittenCommand) {
  const updatedInput = { ...input, command: rewrittenCommand };
  const response = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput,
    },
  };

  process.stdout.write(`${JSON.stringify(response)}\n`);
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) {
    return;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  const commandInfo = getCommand(payload);
  if (!commandInfo) {
    return;
  }

  if (isRtkCommand(commandInfo.command)) {
    recordMiss("rtk_command_bypass", commandInfo.command);
    return;
  }

  const rewritten = rewriteCommand(commandInfo.command);
  if (!rewritten) {
    return;
  }

  emitUpdatedInput(payload, commandInfo.input, rewritten);
}

main().catch(() => {
  process.exit(0);
});
