/**
 * PAI OpenCode plugin
 *
 * Bridges OpenCode's native plugin events to PAI's existing hook scripts.
 * OpenCode auto-loads local plugins from ~/.config/opencode/plugins/.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { spawnSync } from "child_process";

type JsonObject = Record<string, any>;
type FrameworkState = { active?: string; root?: string; dataDir?: string };

const FRAMEWORK = "opencode";
const ROOT = resolve(import.meta.dir, "..");
const HOME = process.env.HOME || process.env.USERPROFILE || homedir();

function readJson(path: string): JsonObject | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function frameworkStateAt(dataDir: string): FrameworkState | null {
  const parsed = readJson(join(dataDir, "framework.json"));
  return parsed && typeof parsed === "object" ? parsed as FrameworkState : null;
}

function existingEnvPath(key: string): string {
  const value = process.env[key];
  return value && existsSync(value) ? value : "";
}

function resolveDataDir(): string {
  const envData = existingEnvPath("PAI_DATA_DIR");
  if (envData) {
    const state = frameworkStateAt(envData);
    if (!state || !state.root || existsSync(state.root)) return envData;
  }
  const defaultData = join(HOME, ".pai");
  const defaultState = frameworkStateAt(defaultData);
  if (defaultState?.dataDir && existsSync(defaultState.dataDir)) return defaultState.dataDir;
  return defaultData;
}

const DATA_DIR = resolveDataDir();
const STATE = frameworkStateAt(DATA_DIR);
const FRAMEWORK_ROOT = STATE?.root && existsSync(STATE.root) ? STATE.root : ROOT;
const PAI_DIR = existingEnvPath("PAI_DIR") || join(FRAMEWORK_ROOT, "PAI");
const CONFIG_DIR = existingEnvPath("PAI_CONFIG_DIR") || join(HOME, ".config", "PAI");
const SETTINGS_PATH = existingEnvPath("PAI_SETTINGS_PATH") || join(FRAMEWORK_ROOT, "settings.json");
const ADAPTER = join(ROOT, "hooks", "FrameworkHookAdapter.ts");

const PRE_TOOL_HOOKS = new Set(["bash", "shell", "write", "edit", "read", "apply_patch"]);
const CONTENT_TOOLS = new Set(["webfetch", "websearch"]);
const TELOS_TOOLS = new Set(["write", "edit", "apply_patch"]);
const seenTranscriptRecords = new Set<string>();
const loadedSessionContext = new Set<string>();
const injectedSessionContext = new Set<string>();
const sessionContext = new Map<string, string>();

function hookEnv(): Record<string, string> {
  return {
    ...process.env,
    PAI_DIR,
    PAI_DATA_DIR: DATA_DIR,
    PAI_FRAMEWORK: FRAMEWORK,
    PAI_FRAMEWORK_DIR: FRAMEWORK_ROOT,
    PAI_SETTINGS_PATH: SETTINGS_PATH,
    PAI_CONFIG_DIR: CONFIG_DIR,
  } as Record<string, string>;
}

function mapToolName(tool: unknown): string {
  switch (String(tool || "").toLowerCase()) {
    case "bash":
    case "shell":
      return "Bash";
    case "read":
      return "Read";
    case "write":
      return "Write";
    case "edit":
      return "Edit";
    case "apply_patch":
      return "MultiEdit";
    case "webfetch":
      return "WebFetch";
    case "websearch":
      return "WebSearch";
    case "skill":
      return "Skill";
    default:
      return String(tool || "Unknown");
  }
}

function sessionId(input: JsonObject): string {
  return input.sessionID || input.sessionId || input.session?.id || "opencode-session";
}

function safeSessionName(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]+/g, "-").slice(0, 120) || "opencode-session";
}

function transcriptPath(input: JsonObject): string {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const dir = join(DATA_DIR, "TRANSCRIPTS", FRAMEWORK, year, month, day);
  mkdirSync(dir, { recursive: true });
  return join(dir, `${safeSessionName(sessionId(input))}.jsonl`);
}

function stableKey(record: JsonObject): string {
  const text =
    typeof record.text === "string"
      ? record.text
      : textFromValue(record.content ?? record.message ?? record);
  return JSON.stringify({
    type: record.type,
    role: record.role,
    sessionId: record.sessionId,
    text: text.slice(0, 500),
    name: record.name,
  });
}

function appendTranscript(input: JsonObject, record: JsonObject): void {
  try {
    const normalized = {
      timestamp: new Date().toISOString(),
      framework: FRAMEWORK,
      sessionId: sessionId(input),
      cwd: input.cwd || input.directory || input.worktree || ROOT,
      ...record,
    };
    const key = stableKey(normalized);
    if (seenTranscriptRecords.has(key)) return;
    seenTranscriptRecords.add(key);
    appendFileSync(transcriptPath(input), `${JSON.stringify(normalized)}\n`, "utf-8");
  } catch {
    // Transcript capture should never break OpenCode execution.
  }
}

function textFromValue(value: unknown, depth = 0): string {
  if (depth > 4 || value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return "";
  if (Array.isArray(value)) {
    return value.map((item) => textFromValue(item, depth + 1)).filter(Boolean).join("\n");
  }
  if (typeof value !== "object") return "";

  const obj = value as JsonObject;
  for (const key of ["text", "content", "message", "body", "value"]) {
    const text = textFromValue(obj[key], depth + 1);
    if (text) return text;
  }
  return "";
}

function roleFromEvent(event: JsonObject): "user" | "assistant" | null {
  const rawRole =
    event.role ||
    event.message?.role ||
    event.properties?.role ||
    event.properties?.info?.role ||
    event.properties?.message?.role;
  const role = String(rawRole || "").toLowerCase();
  if (role === "user" || role === "assistant") return role;
  return null;
}

function runHook(hookFile: string, payload: JsonObject): { code: number; stdout: string; stderr: string } {
  if (!existsSync(ADAPTER)) {
    return { code: 0, stdout: "", stderr: `PAI adapter not found: ${ADAPTER}` };
  }

  const result = spawnSync(process.execPath, [ADAPTER, "--framework", FRAMEWORK, "--target", hookFile], {
    cwd: ROOT,
    env: hookEnv(),
    input: JSON.stringify(payload),
    encoding: "utf-8",
  });

  return {
    code: result.status ?? 0,
    stdout: result.stdout?.toString() || "",
    stderr: result.stderr?.toString() || "",
  };
}

function blocks(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.decision === "block") return parsed.reason || "PAI hook blocked this operation";
    } catch {
      // Ignore non-JSON hook output.
    }
  }
  return null;
}

function toolPayload(eventName: string, input: JsonObject, output: JsonObject): JsonObject {
  return {
    framework: FRAMEWORK,
    session_id: sessionId(input),
    hook_event_name: eventName,
    tool_name: mapToolName(input.tool),
    tool_input: output.args || input.args || {},
    tool_result: output.output || output.result || output.metadata || "",
  };
}

function sessionPayload(input: JsonObject): JsonObject {
  return {
    framework: FRAMEWORK,
    session_id: sessionId(input),
    hook_event_name: "SessionStart",
    source: input.source || "startup",
    cwd: input.cwd || input.directory || input.worktree || ROOT,
  };
}

function recordTool(input: JsonObject, output: JsonObject): void {
  appendTranscript(input, {
    type: "tool_call",
    name: String(input.tool || "Unknown"),
    arguments: output.args || input.args || {},
    result: output.output || output.result || output.metadata || "",
  });
}

function enforce(hookFile: string, payload: JsonObject): void {
  const result = runHook(hookFile, payload);
  const blockReason = blocks(result.stdout);
  if (result.code === 2 || blockReason) {
    throw new Error(blockReason || result.stderr.trim() || `PAI hook blocked ${payload.tool_name}`);
  }
}

function observe(hookFile: string, payload: JsonObject): void {
  try {
    runHook(hookFile, payload);
  } catch {
    // Observability hooks should never break OpenCode execution.
  }
}

function promptContext(stdout: string): string {
  const match = stdout.match(/<system-reminder>[\s\S]*?<\/system-reminder>/);
  return match?.[0]?.trim() || "";
}

function loadSessionContext(input: JsonObject): void {
  const id = sessionId(input);
  if (loadedSessionContext.has(id)) return;
  loadedSessionContext.add(id);

  try {
    const result = runHook("LoadContext.hook.ts", sessionPayload(input));
    if (result.code !== 0) return;
    const context = promptContext(result.stdout);
    if (context) sessionContext.set(id, context);
  } catch {
    // Dynamic context injection should not break OpenCode execution.
  }
}

function injectSessionContext(input: JsonObject, output: JsonObject, prompt: string): void {
  const id = sessionId(input);
  if (injectedSessionContext.has(id)) return;
  if (!loadedSessionContext.has(id)) loadSessionContext(input);

  const context = sessionContext.get(id);
  if (!context) return;

  if (typeof output.text === "string" && typeof output.prompt !== "string") {
    output.text = `${context}\n\n${output.text || prompt}`;
  } else {
    output.prompt = `${context}\n\n${output.prompt || prompt}`;
  }
  injectedSessionContext.add(id);
}

export const PAIOpenCodePlugin = async () => {
  return {
    "shell.env": async (_input: JsonObject, output: JsonObject) => {
      output.env ||= {};
      Object.assign(output.env, hookEnv());
    },

    "tool.execute.before": async (input: JsonObject, output: JsonObject) => {
      if (!PRE_TOOL_HOOKS.has(String(input.tool || "").toLowerCase())) return;
      enforce("SecurityPipeline.hook.ts", toolPayload("PreToolUse", input, output));
    },

    "tool.execute.after": async (input: JsonObject, output: JsonObject) => {
      const tool = String(input.tool || "").toLowerCase();
      const payload = toolPayload("PostToolUse", input, output);
      recordTool(input, output);

      if (CONTENT_TOOLS.has(tool)) observe("ContentScanner.hook.ts", payload);
      if (TELOS_TOOLS.has(tool)) observe("TelosSummarySync.hook.ts", payload);
      observe("ToolActivityTracker.hook.ts", payload);
    },

    "tui.prompt.append": async (input: JsonObject, output: JsonObject) => {
      const prompt = output.prompt || output.text || input.prompt || input.text || "";
      if (!prompt) return;
      appendTranscript(input, {
        type: "message",
        role: "user",
        content: [{ type: "text", text: prompt }],
      });
      enforce("PromptGuard.hook.ts", {
        framework: FRAMEWORK,
        session_id: sessionId(input),
        hook_event_name: "UserPromptSubmit",
        prompt,
      });
      enforce("RepeatDetection.hook.ts", {
        framework: FRAMEWORK,
        session_id: sessionId(input),
        hook_event_name: "UserPromptSubmit",
        prompt,
      });
      injectSessionContext(input, output, prompt);
    },

    "experimental.session.compacting": async (input: JsonObject) => {
      observe("PreCompact.hook.ts", {
        framework: FRAMEWORK,
        session_id: sessionId(input),
        hook_event_name: "PreCompact",
      });
    },

    event: async ({ event }: { event: JsonObject }) => {
      if (event?.type === "session.created") {
        observe("KittyEnvPersist.hook.ts", sessionPayload(event));
        loadSessionContext(event);
      }

      if (event?.type === "session.created" || event?.type === "session.updated") {
        appendTranscript(event, {
          type: "session_meta",
          payload: {
            id: sessionId(event),
            cwd: event.cwd || event.directory || event.worktree || ROOT,
          },
        });
      }

      if (String(event?.type || "").startsWith("message.")) {
        const role = roleFromEvent(event);
        const text = textFromValue(event.message || event.part || event.properties || event.content);
        if (role && text) {
          appendTranscript(event, {
            type: "message",
            role,
            content: [{ type: "text", text }],
            eventType: event.type,
          });
        }
      }

      if (event?.type !== "session.idle") return;
      appendTranscript(event, { type: "event", eventType: "session.idle" });
      const payload = {
        framework: FRAMEWORK,
        session_id: sessionId(event),
        hook_event_name: "Stop",
      };
      observe("LastResponseCache.hook.ts", payload);
      observe("ResponseTabReset.hook.ts", payload);
      observe("VoiceCompletion.hook.ts", payload);
      observe("DocIntegrity.hook.ts", payload);
    },
  };
};
