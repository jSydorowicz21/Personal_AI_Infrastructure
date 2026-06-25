#!/usr/bin/env bun
/**
 * ConfigAudit.hook.ts - ConfigChange Event Logger
 *
 * PURPOSE:
 * Security audit trail for configuration changes. Logs what changed, when,
 * and in which session. Uses file-diff against a cached snapshot to detect
 * which top-level keys actually changed (the event stdin doesn't provide this).
 *
 * TRIGGER: ConfigChange (command-only event)
 *
 * OUTPUTS:
 * - MEMORY/OBSERVABILITY/config-changes.jsonl (structured audit log)
 * - stderr logging for hook diagnostics
 *
 * PERFORMANCE: <30ms (file read + diff + append)
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from 'fs';
import { basename, isAbsolute, join, relative, resolve } from 'path';
import { memoryPath, getSettingsPath, getFrameworkDir, expandPath } from './lib/paths';
import { getISOTimestamp } from './lib/time';

interface ConfigChangeInput {
  session_id: string;
  transcript_path: string;
  hook_event_name: string;
  config_path?: string;
  config_key?: string;
  old_value?: unknown;
  new_value?: unknown;
}

interface ConfigChangeEvent {
  timestamp: string;
  event: 'config_change';
  session_id: string;
  config_path: string;
  config_key: string;
  change_summary: string;
}

const OBS_DIR = memoryPath('OBSERVABILITY');
const AUDIT_FILE = join(OBS_DIR, 'config-changes.jsonl');
const SNAPSHOT_DIR = memoryPath('STATE', 'config-audit');

// Sensitive keys that warrant extra logging
const SENSITIVE_KEYS = new Set([
  'permissions', 'hooks', 'env', 'mcpServers', 'mcp_servers',
  'permissions.allow', 'permissions.deny', 'permissions.ask',
]);

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => resolve(data), 2000);
    process.stdin.on('data', (chunk) => { data += chunk.toString(); });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(data); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(data); });
  });
}

function normalizeFramework(value: string | undefined): string {
  return (value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function defaultConfigPath(): string {
  const frameworkDir = getFrameworkDir();
  const framework = normalizeFramework(process.env.PAI_FRAMEWORK);
  if (framework === 'codex' || framework === 'opencode' || framework === 'open') {
    return join(frameworkDir, 'config.toml');
  }
  return getSettingsPath();
}

function resolveConfigPath(inputPath?: string): string {
  if (!inputPath?.trim()) return defaultConfigPath();
  const expanded = expandPath(inputPath.trim());
  if (isAbsolute(expanded) || /^[A-Za-z]:[\\/]/.test(expanded)) return resolve(expanded);
  return resolve(getFrameworkDir(), expanded);
}

function displayConfigPath(configPath: string, inputPath?: string): string {
  if (inputPath?.trim()) return inputPath.trim().replace(/\\/g, '/');
  const frameworkDir = resolve(getFrameworkDir());
  const resolved = resolve(configPath);
  if (resolved.toLowerCase().startsWith(frameworkDir.toLowerCase())) {
    return relative(frameworkDir, resolved).replace(/\\/g, '/');
  }
  return configPath.replace(/\\/g, '/');
}

function snapshotPathFor(configPath: string): string {
  const normalized = resolve(configPath)
    .replace(/^[A-Za-z]:/, '')
    .replace(/[^A-Za-z0-9_.-]+/g, '_')
    .replace(/^_+/, '')
    .slice(-160);
  return join(SNAPSHOT_DIR, `${normalized || basename(configPath)}.json`);
}

function parseTomlLike(text: string): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  let section = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const sectionMatch = line.match(/^\[+([^\]]+)\]+$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      values[section] = true;
      continue;
    }

    const keyMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=/);
    if (!keyMatch) continue;
    const key = section ? `${section}.${keyMatch[1]}` : keyMatch[1];
    values[key] = line.slice(line.indexOf('=') + 1).trim();
  }

  return Object.keys(values).length > 0 ? values : { content: text };
}

function readConfig(configPath: string): Record<string, unknown> {
  const text = readFileSync(configPath, 'utf-8');
  if (configPath.toLowerCase().endsWith('.json')) {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { content: parsed };
  }
  return parseTomlLike(text);
}

/**
 * Diff current config against cached snapshot.
 * Returns array of top-level keys that changed, plus a summary string.
 */
function diffConfig(configPath: string): { changedKeys: string[]; summary: string } {
  const snapshotPath = snapshotPathFor(configPath);
  const configName = basename(configPath);
  let current: Record<string, unknown> = {};
  let snapshot: Record<string, unknown> = {};

  try {
    current = readConfig(configPath);
  } catch {
    return { changedKeys: [configName], summary: `could not read ${configName}` };
  }

  try {
    if (existsSync(snapshotPath)) {
      snapshot = JSON.parse(readFileSync(snapshotPath, 'utf-8'));
    }
  } catch {
    // No snapshot or corrupt — treat everything as new
  }

  // Save new snapshot for next comparison
  try {
    if (!existsSync(SNAPSHOT_DIR)) mkdirSync(SNAPSHOT_DIR, { recursive: true });
    writeFileSync(snapshotPath, JSON.stringify(current), 'utf-8');
  } catch {
    // Non-fatal
  }

  // If no prior snapshot, we can't diff
  if (Object.keys(snapshot).length === 0) {
    return { changedKeys: ['initial'], summary: 'initial snapshot (no prior to diff)' };
  }

  // Compare top-level keys
  const allKeys = new Set([...Object.keys(current), ...Object.keys(snapshot)]);
  const changed: string[] = [];
  const summaryParts: string[] = [];

  for (const key of allKeys) {
    const curVal = JSON.stringify(current[key]);
    const snapVal = JSON.stringify(snapshot[key]);

    if (curVal !== snapVal) {
      changed.push(key);

      if (!(key in snapshot)) {
        summaryParts.push(`${key}: added`);
      } else if (!(key in current)) {
        summaryParts.push(`${key}: removed`);
      } else {
        // For arrays/objects, try to show what changed at second level
        if (typeof current[key] === 'object' && current[key] && typeof snapshot[key] === 'object' && snapshot[key]) {
          const curObj = current[key] as Record<string, unknown>;
          const snapObj = snapshot[key] as Record<string, unknown>;
          const subKeys = new Set([...Object.keys(curObj), ...Object.keys(snapObj)]);
          const subChanged: string[] = [];
          for (const sk of subKeys) {
            if (JSON.stringify(curObj[sk]) !== JSON.stringify(snapObj[sk])) {
              subChanged.push(sk);
            }
          }
          if (subChanged.length <= 3) {
            summaryParts.push(`${key}.{${subChanged.join(',')}}: modified`);
          } else {
            summaryParts.push(`${key}: ${subChanged.length} sub-keys modified`);
          }
        } else {
          const newStr = JSON.stringify(current[key]).slice(0, 80);
          summaryParts.push(`${key}: → ${newStr}`);
        }
      }
    }
  }

  if (changed.length === 0) {
    return { changedKeys: ['unchanged'], summary: 'no diff detected (possible race)' };
  }

  return { changedKeys: changed, summary: summaryParts.join('; ') };
}

function isSensitiveKey(key: string): boolean {
  if (SENSITIVE_KEYS.has(key)) return true;
  for (const sensitive of SENSITIVE_KEYS) {
    if (key.startsWith(`${sensitive}.`)) return true;
  }
  return false;
}

async function main() {
  try {
    const input = await readStdin();
    if (!input.trim()) { process.exit(0); }

    const data: ConfigChangeInput = JSON.parse(input);

    const configPath = resolveConfigPath(data.config_path);

    // Use file-diff to determine what actually changed
    const { changedKeys, summary } = diffConfig(configPath);
    const configKey = changedKeys.join(',');
    const isSensitive = changedKeys.some(isSensitiveKey);

    const event: ConfigChangeEvent = {
      timestamp: getISOTimestamp(),
      event: 'config_change',
      session_id: data.session_id,
      config_path: displayConfigPath(configPath, data.config_path),
      config_key: configKey,
      change_summary: summary,
    };

    if (!existsSync(OBS_DIR)) mkdirSync(OBS_DIR, { recursive: true });
    appendFileSync(AUDIT_FILE, JSON.stringify(event) + '\n', 'utf-8');

    const sensitivity = isSensitive ? ' [SENSITIVE]' : '';
    console.error(`[ConfigAudit] Logged: ${configKey}${sensitivity} — ${summary}`);
  } catch (err) {
    console.error(`[ConfigAudit] Error: ${err}`);
  }
  process.exit(0);
}

main();
