#!/usr/bin/env bun
/**
 * Cost Aggregator — scans all framework session JSONLs for token usage data
 * and computes per-session cost/usage telemetry.
 *
 * Data source: active framework transcript roots.
 * Output: shared MEMORY/OBSERVABILITY/session-costs.jsonl
 *
 * Runs incrementally: tracks last scan time, only processes new/modified files.
 * Called by Pulse cron every 15 minutes or directly for initial scan.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import { memoryPath } from "../../TOOLS/lib/paths";
import { getActiveFramework, getFrameworkSessionRoots, type FrameworkId } from "../../TOOLS/lib/transcripts";

const OUTPUT_FILE = memoryPath("OBSERVABILITY", "session-costs.jsonl");
const STATE_FILE = memoryPath("STATE", "pulse", "performance", "aggregator-state.json");
const RECENT_SCAN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

type BillingSource = "api-estimate" | "subscription" | "unknown";

interface Pricing {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

interface CostComponents {
  costInput: number;
  costOutput: number;
  costCacheWrite: number;
  costCacheRead: number;
  costTotal: number;
}

interface SessionFile {
  path: string;
  framework: FrameworkId;
  mtime: number;
}

interface SessionCost extends TokenUsage, CostComponents {
  sessionKey: string;
  sessionId: string;
  framework: FrameworkId;
  project: string;
  firstTimestamp: string;
  lastTimestamp: string;
  models: Record<string, number>;
  primaryModel: string;
  messageCount: number;
  billingSource: BillingSource;
  pricingSource: string;
  costEstimated: boolean;
  fileSize: number;
  filePath: string;
}

interface AggregatorState {
  lastScanMs: number;
  sessionsProcessed: number;
}

// Claude API-equivalent pricing per million tokens. Codex CLI sessions are
// subscription usage here, so they intentionally do not fall through to this.
const CLAUDE_MODEL_PRICING: Record<string, Pricing> = {
  "claude-opus-4-20250514": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-opus-4-6": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-sonnet-4-20250514": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-sonnet-4-5-20250514": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-haiku-4-5-20251001": { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
};

function claudePricing(model: string): { pricing: Pricing; source: string } {
  if (CLAUDE_MODEL_PRICING[model]) return { pricing: CLAUDE_MODEL_PRICING[model], source: "claude-exact" };
  const lower = model.toLowerCase();
  if (lower.includes("opus")) return { pricing: CLAUDE_MODEL_PRICING["claude-opus-4-6"], source: "claude-family-opus" };
  if (lower.includes("haiku")) return { pricing: CLAUDE_MODEL_PRICING["claude-haiku-4-5-20251001"], source: "claude-family-haiku" };
  if (lower.includes("sonnet")) return { pricing: CLAUDE_MODEL_PRICING["claude-sonnet-4-6"], source: "claude-family-sonnet" };
  return { pricing: CLAUDE_MODEL_PRICING["claude-sonnet-4-6"], source: "claude-default-sonnet" };
}

function zeroUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
}

function zeroCost(): CostComponents {
  return {
    costInput: 0,
    costOutput: 0,
    costCacheWrite: 0,
    costCacheRead: 0,
    costTotal: 0,
  };
}

function loadState(): AggregatorState {
  try {
    if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch {
    // Fresh start.
  }
  return { lastScanMs: 0, sessionsProcessed: 0 };
}

function saveState(state: AggregatorState): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function sessionKey(framework: string, sessionId: string, filePath: string): string {
  return `${framework}:${sessionId}:${filePath}`;
}

function loadExistingSessionKeys(): Set<string> {
  const keys = new Set<string>();
  try {
    if (!existsSync(OUTPUT_FILE)) return keys;
    const lines = readFileSync(OUTPUT_FILE, "utf-8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const d = JSON.parse(line);
        if (d.sessionKey) {
          keys.add(d.sessionKey);
        } else if (d.sessionId) {
          keys.add(sessionKey(d.framework || "claude", d.sessionId, d.filePath || ""));
        }
      } catch {
        // Skip malformed historical rows.
      }
    }
  } catch {
    // No existing file.
  }
  return keys;
}

function collectJsonlFiles(dir: string, framework: FrameworkId, files: SessionFile[] = []): SessionFile[] {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsonlFiles(entryPath, framework, files);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    files.push({
      path: entryPath,
      framework,
      mtime: statSync(entryPath).mtimeMs,
    });
  }
  return files;
}

function discoverSessionFiles(framework: FrameworkId, state: AggregatorState, isFullScan: boolean): SessionFile[] {
  const roots = getFrameworkSessionRoots(framework);
  const unique = new Map<string, SessionFile>();
  for (const root of roots) {
    for (const file of collectJsonlFiles(root, framework)) unique.set(file.path, file);
  }

  let files = [...unique.values()].sort((a, b) => b.mtime - a.mtime);
  if (isFullScan) return files;
  if (state.lastScanMs > 0) return files.filter((file) => file.mtime >= state.lastScanMs);

  const recentCutoff = Date.now() - RECENT_SCAN_WINDOW_MS;
  files = files.filter((file) => file.mtime >= recentCutoff);
  return files;
}

function discoverAllSessionFiles(state: AggregatorState, isFullScan: boolean): SessionFile[] {
  const frameworks: FrameworkId[] = ["claude", "codex", "opencode"];
  const unique = new Map<string, SessionFile>();
  for (const framework of frameworks) {
    for (const file of discoverSessionFiles(framework, state, isFullScan)) {
      unique.set(file.path, file);
    }
  }
  return [...unique.values()].sort((a, b) => b.mtime - a.mtime);
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usageFromObject(usage: any): TokenUsage | null {
  if (!usage || typeof usage !== "object") return null;

  const inputTokens = asNumber(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens);
  const outputTokens = asNumber(usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens);
  const cacheWriteTokens = asNumber(
    usage.cache_creation_input_tokens ??
      usage.cache_write_input_tokens ??
      usage.cacheWriteTokens ??
      usage.cache_write_tokens,
  );
  const cacheReadTokens = asNumber(
    usage.cache_read_input_tokens ??
      usage.cached_input_tokens ??
      usage.cacheReadTokens ??
      usage.cache_read_tokens,
  );
  const reasoningOutputTokens = asNumber(usage.reasoning_output_tokens ?? usage.reasoningOutputTokens);
  const reportedTotal = asNumber(usage.total_tokens ?? usage.totalTokens);
  const computedTotal = inputTokens + outputTokens + cacheWriteTokens + cacheReadTokens;
  const totalTokens = reportedTotal > 0 ? reportedTotal : computedTotal;

  if (totalTokens === 0) return null;
  return {
    inputTokens,
    outputTokens,
    cacheWriteTokens,
    cacheReadTokens,
    reasoningOutputTokens,
    totalTokens,
  };
}

function addUsage(acc: TokenUsage, usage: TokenUsage): void {
  acc.inputTokens += usage.inputTokens;
  acc.outputTokens += usage.outputTokens;
  acc.cacheWriteTokens += usage.cacheWriteTokens;
  acc.cacheReadTokens += usage.cacheReadTokens;
  acc.reasoningOutputTokens += usage.reasoningOutputTokens;
  acc.totalTokens += usage.totalTokens;
}

function addCost(acc: CostComponents, model: string, usage: TokenUsage): string {
  const { pricing, source } = claudePricing(model);
  acc.costInput += (usage.inputTokens * pricing.input) / 1_000_000;
  acc.costOutput += (usage.outputTokens * pricing.output) / 1_000_000;
  acc.costCacheWrite += (usage.cacheWriteTokens * pricing.cacheWrite) / 1_000_000;
  acc.costCacheRead += (usage.cacheReadTokens * pricing.cacheRead) / 1_000_000;
  acc.costTotal = acc.costInput + acc.costOutput + acc.costCacheWrite + acc.costCacheRead;
  return source;
}

function roundedCost(cost: CostComponents): CostComponents {
  return {
    costInput: Math.round(cost.costInput * 10000) / 10000,
    costOutput: Math.round(cost.costOutput * 10000) / 10000,
    costCacheWrite: Math.round(cost.costCacheWrite * 10000) / 10000,
    costCacheRead: Math.round(cost.costCacheRead * 10000) / 10000,
    costTotal: Math.round(cost.costTotal * 10000) / 10000,
  };
}

function noteTimestamp(ts: unknown, range: { first: string; last: string }): void {
  if (typeof ts !== "string" || !ts) return;
  if (!range.first || ts < range.first) range.first = ts;
  if (!range.last || ts > range.last) range.last = ts;
}

function projectFromContext(framework: FrameworkId, filePath: string, cwd: string): string {
  if (cwd) return basename(cwd);
  if (framework !== "claude") return "<unknown-project>";

  const parent = basename(dirname(filePath));
  if (parent === "subagents") return basename(dirname(dirname(dirname(filePath))));
  return parent;
}

function processSessionFile(filePath: string, framework: FrameworkId): SessionCost | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    const models: Record<string, number> = {};
    const range = { first: "", last: "" };
    const usageTotal = zeroUsage();
    const costTotal = zeroCost();

    let sessionId = basename(filePath, ".jsonl");
    let cwd = "";
    let messageCount = 0;
    let pricingSource = framework === "claude" ? "claude-unseen" : `${framework}-native-usage`;
    let billingSource: BillingSource = framework === "claude" ? "api-estimate" : "unknown";
    let codexUsage: TokenUsage | null = null;
    let codexModel = "codex-subscription";
    let codexTokenEvents = 0;
    let opencodeUsageSeen = false;

    for (const line of lines) {
      let d: any;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }

      noteTimestamp(d.timestamp, range);
      if (d.sessionId) sessionId = String(d.sessionId);

      if (d.type === "session_meta") {
        if (d.payload?.id) sessionId = String(d.payload.id);
        if (d.payload?.session_id) sessionId = String(d.payload.session_id);
        if (typeof d.payload?.cwd === "string") cwd = d.payload.cwd;
        continue;
      }
      if (typeof d.cwd === "string") cwd = d.cwd;

      if (framework === "codex") {
        if (d.type === "response_item" && d.payload?.type === "message" && d.payload.role === "assistant") {
          messageCount += 1;
        }
        if (d.type !== "event_msg" || d.payload?.type !== "token_count") continue;

        const totalUsage = usageFromObject(d.payload.info?.total_token_usage);
        if (!totalUsage) continue;

        const planType = d.payload.rate_limits?.plan_type;
        codexModel = typeof planType === "string" && planType ? `codex-subscription-${planType}` : "codex-subscription";
        codexUsage = totalUsage;
        codexTokenEvents += 1;
        billingSource = "subscription";
        pricingSource = "codex-token-count";
        continue;
      }

      if (framework === "opencode") {
        if (d.type === "message" && d.role === "assistant") messageCount += 1;
        const model = d.model || d.provider?.model || "opencode-session";
        const usage = usageFromObject(d.usage || d.metrics?.usage || d.tokens);
        if (!usage) continue;
        addUsage(usageTotal, usage);
        models[model] = (models[model] ?? 0) + 1;
        opencodeUsageSeen = true;
        billingSource = "unknown";
        pricingSource = "opencode-token-usage";
        continue;
      }

      if (d.type !== "assistant") continue;
      const msg = d.message;
      if (!msg?.usage) continue;

      const model = msg.model || "<unknown>";
      if (model === "<synthetic>") continue;
      const usage = usageFromObject(msg.usage);
      if (!usage) continue;

      addUsage(usageTotal, usage);
      pricingSource = addCost(costTotal, model, usage);
      models[model] = (models[model] ?? 0) + 1;
      messageCount += 1;
      billingSource = "api-estimate";
    }

    if (framework === "codex") {
      if (!codexUsage) return null;
      Object.assign(usageTotal, codexUsage);
      models[codexModel] = Math.max(codexTokenEvents, messageCount, 1);
      messageCount = Math.max(messageCount, codexTokenEvents, 1);
    } else if (framework === "opencode") {
      if (!opencodeUsageSeen) return null;
      messageCount = Math.max(messageCount, 1);
    } else if (messageCount === 0) {
      return null;
    }

    const primaryModel = Object.entries(models).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "<unknown>";
    const fileSize = statSync(filePath).size;
    const rounded = roundedCost(costTotal);
    const project = projectFromContext(framework, filePath, cwd);

    return {
      sessionKey: sessionKey(framework, sessionId, filePath),
      sessionId,
      framework,
      project,
      firstTimestamp: range.first,
      lastTimestamp: range.last,
      models,
      primaryModel,
      messageCount,
      ...usageTotal,
      ...rounded,
      billingSource,
      pricingSource,
      costEstimated: framework === "claude",
      fileSize,
      filePath,
    };
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const startMs = Date.now();
  const state = loadState();
  const existingKeys = loadExistingSessionKeys();
  const isFullScan = process.argv.includes("--full");
  const sessionFiles = discoverAllSessionFiles(state, isFullScan);

  if (sessionFiles.length === 0) {
    const roots = ["claude", "codex", "opencode"].flatMap((framework) => getFrameworkSessionRoots(framework));
    console.log(`No session files found in: ${roots.join(", ")}`);
    process.exit(0);
  }

  mkdirSync(dirname(OUTPUT_FILE), { recursive: true });

  let newSessions = 0;
  let skipped = 0;
  let ignored = 0;

  for (const file of sessionFiles) {
    const cost = processSessionFile(file.path, file.framework);
    if (!cost) {
      ignored += 1;
      continue;
    }

    if (!isFullScan && existingKeys.has(cost.sessionKey)) {
      skipped += 1;
      continue;
    }

    appendFileSync(OUTPUT_FILE, `${JSON.stringify(cost)}\n`);
    existingKeys.add(cost.sessionKey);
    newSessions += 1;
  }

  state.lastScanMs = Date.now();
  state.sessionsProcessed += newSessions;
  saveState(state);

  const elapsed = Date.now() - startMs;
  console.log(`Cost aggregation complete: ${newSessions} new, ${skipped} skipped, ${ignored} ignored (${elapsed}ms)`);
}

main().catch((err) => {
  console.error("Cost aggregator failed:", err);
  process.exit(1);
});
