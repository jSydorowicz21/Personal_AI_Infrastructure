#!/usr/bin/env bun
/**
 * FrameworkHookAdapter.ts
 *
 * Normalizes non-Claude hook payloads into the Claude-shaped fields used by
 * PAI's existing hook implementations, then delegates to the target hook.
 */

import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { extname, join, resolve } from "path";
import { isSubagentSession } from "./lib/session";

type JsonObject = Record<string, any>;

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

function timeoutMs(): number {
  const raw = Number(argValue("--timeout-ms") || process.env.PAI_HOOK_CHILD_TIMEOUT_MS || "");
  return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
}

function eventName(input: JsonObject): string {
  return (
    input.hook_event_name ||
    input.hookEventName ||
    input.event_name ||
    input.eventName ||
    input.event ||
    "unknown"
  );
}

function toolName(input: JsonObject): string {
  return (
    input.tool_name ||
    input.toolName ||
    input.tool?.name ||
    input.name ||
    input.tool ||
    "Unknown"
  );
}

function patchPath(patchText: string): string {
  const match = patchText.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/m)
    || patchText.match(/^\*\*\* Move to: (.+)$/m);
  return match?.[1]?.trim() || "";
}

function normalizeToolInput(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input ?? {};

  const out: JsonObject = { ...(input as JsonObject) };
  const filePath =
    out.file_path ||
    out.filePath ||
    out.path ||
    out.absolutePath ||
    (typeof out.patchText === "string" ? patchPath(out.patchText) : "");

  if (filePath && !out.file_path) out.file_path = filePath;
  if (out.oldString && !out.old_string) out.old_string = out.oldString;
  if (out.newString && !out.new_string) out.new_string = out.newString;
  if (out.patchText && !out.patch_text) out.patch_text = out.patchText;

  return out;
}

function toolInput(input: JsonObject): unknown {
  return normalizeToolInput(
    input.tool_input ??
    input.toolInput ??
    input.tool?.input ??
    input.arguments ??
    input.args ??
    input.input ??
    {}
  );
}

function toolResult(input: JsonObject): unknown {
  return (
    input.tool_result ??
    input.toolResult ??
    input.tool_response ??
    input.toolResponse ??
    input.result ??
    input.output
  );
}

function promptText(input: JsonObject): string {
  if (typeof input.prompt === "string") return input.prompt;
  if (typeof input.user_prompt === "string") return input.user_prompt;
  if (typeof input.userPrompt === "string") return input.userPrompt;
  if (typeof input.message === "string") return input.message;
  if (Array.isArray(input.messages)) {
    const last = [...input.messages].reverse().find((m) => typeof m?.content === "string");
    if (last) return last.content;
  }
  return "";
}

function cwd(input: JsonObject): string {
  return (
    input.cwd ||
    input.workingDirectory ||
    input.working_directory ||
    input.session?.cwd ||
    input.session?.workingDirectory ||
    process.cwd()
  );
}

function transcriptPath(input: JsonObject): string | undefined {
  return (
    input.transcript_path ||
    input.transcriptPath ||
    input.session?.transcript_path ||
    input.session?.transcriptPath ||
    input.session?.logPath ||
    input.logPath
  );
}

function lastAssistantMessage(input: JsonObject): string {
  if (typeof input.last_assistant_message === "string") return input.last_assistant_message;
  if (typeof input.lastAssistantMessage === "string") return input.lastAssistantMessage;
  if (!Array.isArray(input.messages)) return "";
  const last = [...input.messages].reverse().find((m) => {
    const role = String(m?.role || m?.type || "").toLowerCase();
    return role === "assistant" && typeof m?.content === "string";
  });
  return last?.content || "";
}

function normalize(input: JsonObject, framework: string): JsonObject {
  const normalizedCwd = cwd(input);
  const normalizedToolResult = toolResult(input);
  return {
    ...input,
    framework,
    session_id:
      input.session_id ||
      input.sessionId ||
      input.session?.id ||
      process.env.CODEX_SESSION_ID ||
      process.env.OPENCODE_SESSION_ID ||
      "pai-framework-session",
    cwd: normalizedCwd,
    transcript_path: transcriptPath(input),
    last_assistant_message: lastAssistantMessage(input),
    hook_event_name: eventName(input),
    tool_name: toolName(input),
    tool_input: toolInput(input),
    tool_result: normalizedToolResult,
    tool_response: normalizedToolResult,
    prompt: promptText(input),
  };
}

async function main() {
  const targetArg = argValue("--target");
  if (!targetArg) {
    console.error("[PAI FrameworkHookAdapter] Missing --target <hook-file>");
    process.exit(1);
  }

  const framework = argValue("--framework") || process.env.PAI_FRAMEWORK || "codex";
  const hooksDir = import.meta.dir;
  const targetPath = resolve(join(hooksDir, targetArg));
  if (!existsSync(targetPath)) {
    console.error(`[PAI FrameworkHookAdapter] Target hook not found: ${targetPath}`);
    process.exit(1);
  }

  let input: JsonObject = {};
  const raw = await Bun.stdin.text();
  if (raw.trim()) {
    try {
      input = JSON.parse(raw);
    } catch {
      input = {};
    }
  }

  const extension = extname(targetPath);
  const runner = extension === ".sh" ? (Bun.which("bash") || "") : process.execPath;
  if (!runner) {
    // Shell-only hooks are optional quality-of-life adapters. Do not break a
    // Windows Codex install just because Git Bash is unavailable.
    process.exit(0);
  }
  const childArgs = extension === ".sh" ? [targetPath] : [targetPath];

  const child = spawnSync(runner, childArgs, {
    input: JSON.stringify(normalize(input, framework)),
    stdio: ["pipe", "inherit", "inherit"],
    timeout: timeoutMs(),
    env: {
      ...process.env,
      PAI_FRAMEWORK: framework,
      PAI_IS_SUBAGENT: isSubagentSession(input) ? "1" : process.env.PAI_IS_SUBAGENT || "",
      PAI_PROJECT_DIR: cwd(input),
    },
  });

  process.exit(child.status ?? 0);
}

main().catch((err) => {
  console.error(`[PAI FrameworkHookAdapter] ${err?.message || err}`);
  process.exit(1);
});
