#!/usr/bin/env bun
/**
 * KVSync.hook.ts — Push work.json to Cloudflare KV at session boundaries
 *
 * TRIGGER: SessionStart, SessionEnd
 *
 * Ensures KV always has fresh work.json data regardless of whether ISASync
 * fires during the session. Prevents the recurring "activity page empty"
 * issue caused by KV going stale between sessions.
 */

import { readFileSync } from 'fs';
import { pushStateToTargets, pushEventsToTargets } from './lib/observability-transport';

const DEFAULT_TIMEOUT_MS = process.env.PAI_FRAMEWORK === 'codex' ? 3000 : 15000;

function timeoutMs(): number {
  const raw = Number(process.env.PAI_KVSYNC_HOOK_TIMEOUT_MS || '');
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

function withTimeout(promise: Promise<unknown>, ms: number): Promise<unknown> {
  return Promise.race([
    promise,
    new Promise<void>((resolve) => {
      setTimeout(() => {
        console.error(`[KVSync] Timed out after ${ms}ms; continuing`);
        resolve();
      }, ms);
    }),
  ]);
}

// Read stdin (required by hook protocol) but we don't need the input
try { readFileSync(0, 'utf-8'); } catch {}

withTimeout(Promise.all([pushStateToTargets(), pushEventsToTargets()]), timeoutMs())
  .catch((err) => console.error(`[KVSync] Fatal: ${err.message}`))
  .finally(() => {
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  });
