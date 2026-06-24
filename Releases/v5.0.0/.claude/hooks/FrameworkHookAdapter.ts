#!/usr/bin/env bun
/**
 * FrameworkHookAdapter.ts
 *
 * Normalizes non-Claude hook payloads into the Claude-shaped fields used by
 * PAI's existing hook implementations, then delegates to the target hook.
 */

import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { basename, extname, join, resolve } from "path";
import { blockEmissionForFramework, shouldExitCleanlyOnBlock } from "./lib/framework-hook-contract";
import { isSubagentSession } from "./lib/session";

type JsonObject = Record<string, any>;
type CapturedOutput = {
  json: JsonObject[];
  text: string[];
};
type MergedHookOutput = {
  decision?: JsonObject;
  permission?: JsonObject;
  updatedInput?: unknown;
  additionalContext: string[];
  hookEventName?: string;
  continueValue?: boolean;
};

function childBlockReason(targetPath: string, stderr: string): string {
  const cleaned = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  return cleaned || `[PAI SECURITY] ${basename(targetPath)} blocked this tool call.`;
}

function exitAfterChildBlock(framework: string, targetPath: string, stderr: string, merged: MergedHookOutput, fallbackEventName: string): never {
  if (shouldExitCleanlyOnBlock(framework)) {
    if (!merged.decision && !merged.permission) {
      const emission = blockEmissionForFramework(framework, childBlockReason(targetPath, stderr));
      if (emission.output) console.log(JSON.stringify(emission.output));
      process.exit(emission.exitCode);
    }
    emitMergedOutput(merged, fallbackEventName);
    process.exit(0);
  }

  emitMergedOutput(merged, fallbackEventName);
  process.exit(2);
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

function targetArgs(): string[] {
  const raw = argValue("--target") || argValue("--targets") || "";
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

function timeoutMs(): number {
  const raw = Number(argValue("--timeout-ms") || process.env.PAI_HOOK_CHILD_TIMEOUT_MS || "");
  return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
}

const RECURSION_GUARDED_HOOKS = new Set([
  "PromptGuard.hook.ts",
  "RepeatDetection.hook.ts",
  "PromptProcessing.hook.ts",
  "SatisfactionCapture.hook.ts",
]);

function shouldSkipForNestedInference(target: string): boolean {
  if (process.env.PAI_INFERENCE_CHILD !== "1" && process.env.PAI_DISABLE_RECURSIVE_HOOKS !== "1") {
    return false;
  }
  return RECURSION_GUARDED_HOOKS.has(basename(target));
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

function captureStdout(stdout: string): CapturedOutput {
  const captured: CapturedOutput = { json: [], text: [] };
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        captured.json.push(parsed as JsonObject);
        continue;
      }
    } catch {}
    captured.text.push(line);
  }
  return captured;
}

function mergeCapturedJson(merged: MergedHookOutput, entries: JsonObject[]): "continue" | "stop" {
  for (const entry of entries) {
    if (typeof entry.decision === "string") {
      merged.decision = entry;
      return "stop";
    }

    if (typeof entry.continue === "boolean") {
      merged.continueValue = merged.continueValue ?? entry.continue;
    }

    const hookOutput = entry.hookSpecificOutput;
    if (!hookOutput || typeof hookOutput !== "object") continue;

    if (typeof hookOutput.hookEventName === "string") {
      merged.hookEventName = merged.hookEventName || hookOutput.hookEventName;
    }

    const permissionDecision = String(hookOutput.permissionDecision || "");
    if (permissionDecision && permissionDecision !== "allow") {
      merged.permission = hookOutput;
      return "stop";
    }

    if ("updatedInput" in hookOutput) {
      merged.updatedInput = hookOutput.updatedInput;
      merged.hookEventName = merged.hookEventName || hookOutput.hookEventName;
    }

    if (typeof hookOutput.additionalContext === "string" && hookOutput.additionalContext.trim()) {
      merged.additionalContext.push(hookOutput.additionalContext);
      merged.hookEventName = merged.hookEventName || hookOutput.hookEventName;
    }
  }
  return "continue";
}

function emitMergedOutput(merged: MergedHookOutput, fallbackEventName: string): void {
  if (merged.decision) {
    console.log(JSON.stringify(merged.decision));
    return;
  }

  if (merged.permission) {
    console.log(JSON.stringify({ hookSpecificOutput: merged.permission }));
    return;
  }

  const hookSpecificOutput: JsonObject = {};
  if (merged.hookEventName || merged.updatedInput !== undefined || merged.additionalContext.length > 0) {
    hookSpecificOutput.hookEventName = merged.hookEventName || fallbackEventName;
  }
  if (merged.updatedInput !== undefined) {
    hookSpecificOutput.permissionDecision = "allow";
    hookSpecificOutput.updatedInput = merged.updatedInput;
  }
  if (merged.additionalContext.length > 0) {
    hookSpecificOutput.additionalContext = merged.additionalContext.join("\n\n");
  }

  if (Object.keys(hookSpecificOutput).length > 0) {
    console.log(JSON.stringify({ hookSpecificOutput }));
    return;
  }

  if (merged.continueValue === false) {
    console.log(JSON.stringify({ continue: false }));
  }
}

async function main() {
  const targets = targetArgs();
  if (targets.length === 0) {
    console.error("[PAI FrameworkHookAdapter] Missing --target <hook-file>");
    process.exit(1);
  }

  const framework = argValue("--framework") || process.env.PAI_FRAMEWORK || "codex";
  const hooksDir = import.meta.dir;

  let input: JsonObject = {};
  const raw = await Bun.stdin.text();
  if (raw.trim()) {
    try {
      input = JSON.parse(raw);
    } catch {
      input = {};
    }
  }

  const normalizedInput = normalize(input, framework);
  const normalized = JSON.stringify(normalizedInput);
  const fallbackHookEventName = eventName(input);
  const merged: MergedHookOutput = { additionalContext: [] };
  for (const targetArg of targets) {
    const targetPath = resolve(join(hooksDir, targetArg));
    if (!existsSync(targetPath)) {
      console.error(`[PAI FrameworkHookAdapter] Target hook not found: ${targetPath}`);
      process.exit(1);
    }
    if (shouldSkipForNestedInference(targetPath)) continue;

    const extension = extname(targetPath);
    const runner = extension === ".sh" ? (Bun.which("bash") || "") : process.execPath;
    if (!runner) continue;
    const childArgs = extension === ".sh" ? [targetPath] : [targetPath];

    const child = spawnSync(runner, childArgs, {
      input: normalized,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: timeoutMs(),
      env: {
        ...process.env,
        PAI_FRAMEWORK: framework,
        PAI_IS_SUBAGENT: isSubagentSession(input) ? "1" : process.env.PAI_IS_SUBAGENT || "",
        PAI_PROJECT_DIR: cwd(input),
      },
    });

    if (child.stderr) process.stderr.write(child.stderr);
    const captured = captureStdout(child.stdout || "");
    for (const line of captured.text) process.stderr.write(`${line}\n`);
    const mergeAction = mergeCapturedJson(merged, captured.json);

    if (child.error) {
      emitMergedOutput(merged, fallbackHookEventName);
      console.error(`[PAI FrameworkHookAdapter] ${basename(targetPath)} failed: ${child.error.message}`);
      process.exit(124);
    }
    if (child.signal) {
      emitMergedOutput(merged, fallbackHookEventName);
      console.error(`[PAI FrameworkHookAdapter] ${basename(targetPath)} terminated by signal ${child.signal}`);
      process.exit(124);
    }
    if (child.status === null) {
      emitMergedOutput(merged, fallbackHookEventName);
      console.error(`[PAI FrameworkHookAdapter] ${basename(targetPath)} exited without status`);
      process.exit(124);
    }
    if (child.status === 2) exitAfterChildBlock(framework, targetPath, child.stderr || "", merged, fallbackHookEventName);
    if (child.status !== 0 || mergeAction === "stop") {
      emitMergedOutput(merged, fallbackHookEventName);
      process.exit(child.status);
    }
  }

  emitMergedOutput(merged, fallbackHookEventName);
  process.exit(0);
}

main().catch((err) => {
  console.error(`[PAI FrameworkHookAdapter] ${err?.message || err}`);
  process.exit(1);
});
