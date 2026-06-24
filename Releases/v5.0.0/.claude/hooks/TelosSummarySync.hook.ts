#!/usr/bin/env bun
/**
 * TelosSummarySync.hook.ts — Auto-regenerate PRINCIPAL_TELOS.md when TELOS source files change
 *
 * TRIGGER: PostToolUse (Write, Edit)
 *
 * When any file in $PAI_DATA_DIR/USER/TELOS/ is written or edited (except
 * PRINCIPAL_TELOS.md itself and Backups/), regenerates the summary by running
 * GenerateTelosSummary.ts.
 *
 * Design origin: Council debate 2026-03-26 — Reed's precondition that the
 * summary must be generated, never hand-authored, and staleness must be
 * structurally impossible.
 */

import { readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { paiPath, userPath } from './lib/paths';

const TELOS_DIR = userPath('TELOS');
const GENERATOR = paiPath("TOOLS", 'GenerateTelosSummary.ts');

function slash(path: string): string {
  return path.replace(/\\/g, '/');
}

let input: any;
try {
  input = JSON.parse(readFileSync(0, 'utf-8'));
} catch {
  process.exit(0);
}

const filePath: string = input.tool_input?.file_path || '';

// Only trigger for TELOS source files
if (!slash(filePath).startsWith(slash(TELOS_DIR) + '/')) process.exit(0);

// Don't trigger for the summary itself or backups
if (filePath.endsWith('PRINCIPAL_TELOS.md')) process.exit(0);
if (filePath.includes('/Backups/')) process.exit(0);
if (filePath.endsWith('updates.md')) process.exit(0);

try {
  const result = spawnSync(process.execPath, [GENERATOR], {
    timeout: 5000,
    stdio: 'pipe',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`generator exited ${result.status ?? 'null'}: ${String(result.stderr || '').trim().slice(0, 300)}`);
  }
  console.error('📋 TELOS summary auto-regenerated after source file change');
} catch (err) {
  console.error(`⚠️ TELOS summary regeneration failed: ${err}`);
}

process.exit(0);
