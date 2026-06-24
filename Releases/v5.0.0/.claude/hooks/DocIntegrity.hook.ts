#!/usr/bin/env bun
/**
 * DocIntegrity.hook.ts — Check cross-refs if system docs/hooks were modified
 *
 * PURPOSE:
 * Runs deterministic doc integrity checks when system
 * files (hooks, PAI docs, skills, components) were modified during the session.
 * Optional semantic inference runs only when PAI_DOC_INFERENCE=1 or
 * PAI_DOC_INTEGRITY_INFERENCE=1 is set.
 * Self-gating: returns instantly when no system files changed.
 *
 * TRIGGER: Stop
 *
 * NEEDS TRANSCRIPT: Yes (to detect which files were modified via tool_use entries)
 *
 * HANDLER: handlers/DocCrossRefIntegrity.ts
 */

import { readHookInput, parseTranscriptFromInput } from './lib/hook-io';
import { handleDocCrossRefIntegrity } from './handlers/DocCrossRefIntegrity';
import { handleRebuildArchSummary } from './handlers/RebuildArchSummary';

async function main() {
  const input = await readHookInput();
  if (!input) { process.exit(0); }

  const parsed = await parseTranscriptFromInput(input);

  try {
    await handleDocCrossRefIntegrity(parsed, input);
  } catch (err) {
    console.error('[DocIntegrity] Cross-ref handler failed:', err);
  }

  try {
    await handleRebuildArchSummary();
  } catch (err) {
    console.error('[DocIntegrity] Arch-summary handler failed:', err);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('[DocIntegrity] Fatal:', err);
  process.exit(0);
});
