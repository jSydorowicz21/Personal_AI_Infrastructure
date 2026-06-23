#!/usr/bin/env node

const { spawnSync } = require("node:child_process");

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

function rewriteCommand(command) {
  const result = spawnSync("rtk", ["rewrite", command], {
    encoding: "utf8",
    windowsHide: true,
    timeout: rewriteTimeoutMs(),
  });

  if (result.error) {
    if (process.env.PAI_HOOK_DEBUG === "1") {
      process.stderr.write(`[RtkPreToolUse] rtk rewrite failed: ${result.error.message}\n`);
    }
    return null;
  }

  const rewritten = (result.stdout || "").trim();
  if (!rewritten || rewritten === command.trim()) {
    return null;
  }

  if (!rewritten.toLowerCase().startsWith("rtk ")) {
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
