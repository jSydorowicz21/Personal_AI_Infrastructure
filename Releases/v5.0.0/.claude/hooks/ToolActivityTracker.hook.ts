#!/usr/bin/env bun
/**
 * ToolActivityTracker.hook.ts - PostToolUse Event Logger
 *
 * Ground-truth audit capture: what the model did, not what it said it did.
 * Captures tool calls + ground-truth artifacts (file paths, bash exit codes,
 * git state at the time of the call) so the dashboard shows actual effects.
 *
 * TRIGGER: PostToolUse (all tools)
 *
 * OUTPUTS:
 * - MEMORY/OBSERVABILITY/tool-activity.jsonl (structured event log)
 *
 * PERFORMANCE: local capture stays synchronous; external observability fan-out
 * is bounded so PostToolUse cannot stall ordinary tool calls.
 */

import { existsSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { memoryPath } from './lib/paths';
import { getISOTimestamp } from './lib/time';
import { pushEventsToTargets, pushStateToTargets } from './lib/observability-transport';
import { bumpLastToolActivity } from './lib/isa-utils';

interface ToolUseInput {
  session_id: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
}

const OBS_DIR = memoryPath('OBSERVABILITY');
const ACTIVITY_FILE = join(OBS_DIR, 'tool-activity.jsonl');
const OBSERVABILITY_PUSH_BUDGET_MS = Number(process.env.PAI_TOOL_ACTIVITY_PUSH_BUDGET_MS || '750');

// Tools that mutate filesystem state — capture extra ground truth.
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const BASH_TOOLS = new Set(['Bash']);

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => resolve(data), 2000);
    process.stdin.on('data', (chunk) => { data += chunk.toString(); });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(data); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(data); });
  });
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...[truncated]' : s;
}

function gitSnapshot(cwd: string): { head?: string; dirty?: boolean } | undefined {
  try {
    const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 500,
    }).trim();
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 500,
    });
    return { head, dirty: status.trim().length > 0 };
  } catch {
    return undefined;
  }
}

function captureGroundTruth(toolName: string, input: Record<string, unknown>, response: unknown) {
  const gt: Record<string, unknown> = {};

  if (WRITE_TOOLS.has(toolName) && typeof input.file_path === 'string') {
    gt.file_path = input.file_path;
    // Edit/MultiEdit carry the before/after diff in args; capture bounded.
    if (typeof input.old_string === 'string' && typeof input.new_string === 'string') {
      gt.diff = {
        removed: truncate(input.old_string, 500),
        added: truncate(input.new_string, 500),
      };
    }
    if (typeof input.content === 'string') {
      gt.content_preview = truncate(input.content, 500);
      gt.content_bytes = input.content.length;
    }
    const gs = gitSnapshot(process.cwd());
    if (gs) gt.git = gs;
  }

  if (BASH_TOOLS.has(toolName) && typeof input.command === 'string') {
    gt.command = truncate(input.command, 500);
    // Claude Code puts stdout/stderr/exit in tool_response — shape varies.
    if (response && typeof response === 'object') {
      const r = response as Record<string, unknown>;
      if ('stdout' in r && typeof r.stdout === 'string') {
        gt.stdout_preview = truncate(r.stdout, 800);
        gt.stdout_bytes = r.stdout.length;
      }
      if ('stderr' in r && typeof r.stderr === 'string') {
        gt.stderr_preview = truncate(r.stderr, 800);
      }
      if ('exit_code' in r || 'exitCode' in r) {
        gt.exit_code = r.exit_code ?? r.exitCode;
      }
    }
  }

  return Object.keys(gt).length > 0 ? gt : undefined;
}

async function pushObservabilityBounded(wroteState: boolean): Promise<void> {
  if (OBSERVABILITY_PUSH_BUDGET_MS <= 0) return;

  const pushes: Promise<void>[] = [pushEventsToTargets()];
  if (wroteState) pushes.push(pushStateToTargets());

  let timedOut = false;
  await Promise.race([
    Promise.allSettled(pushes).then(() => undefined),
    new Promise<void>((resolve) => {
      setTimeout(() => {
        timedOut = true;
        resolve();
      }, OBSERVABILITY_PUSH_BUDGET_MS);
    }),
  ]);

  if (timedOut && process.env.PAI_HOOK_DEBUG === '1') {
    console.error(`[ToolActivityTracker] observability push exceeded ${OBSERVABILITY_PUSH_BUDGET_MS}ms; local event already captured`);
  }
}

async function main() {
  try {
    const input = await readStdin();
    if (!input.trim()) { process.exit(0); }

    const data: ToolUseInput = JSON.parse(input);
    const toolName = data.tool_name || 'unknown';

    let inputPreview = '';
    if (data.tool_input) {
      const raw = JSON.stringify(data.tool_input);
      inputPreview = raw.length > 300 ? raw.slice(0, 300) + '...' : raw;
    }

    const groundTruth = data.tool_input
      ? captureGroundTruth(toolName, data.tool_input, data.tool_response)
      : undefined;

    const event = {
      timestamp: getISOTimestamp(),
      event: 'tool_use',
      source: 'tool-activity',
      type: 'tool_use',
      session_id: data.session_id,
      tool_name: toolName,
      tool_input_preview: inputPreview,
      ...(groundTruth ? { ground_truth: groundTruth } : {}),
    };

    if (!existsSync(OBS_DIR)) mkdirSync(OBS_DIR, { recursive: true });
    appendFileSync(ACTIVITY_FILE, JSON.stringify(event) + '\n', 'utf-8');

    // Bump lastToolActivity on work.json; push state to CF KV when we actually
    // wrote (i.e. past the 30s debounce). Without this push, the dashboard
    // shows tool-heavy sessions as stale because KV only gets updated on
    // UserPromptSubmit — the 5-10 min stale window elapses between prompts
    // and the session disappears mid-work.
    const wrote = data.session_id ? bumpLastToolActivity(data.session_id) : false;

    await pushObservabilityBounded(wrote);
  } catch (e) {
    console.error('[ToolActivityTracker]', e instanceof Error ? e.message : String(e));
  }
  process.exit(0);
}

main();
