/**
 * Centralized Path Resolution
 *
 * Two root directories:
 * - PAI_DIR (<framework root>/PAI) — PAI system files plus linked MEMORY/USER
 * - Framework home (~/.claude, ~/.codex, ~/.config/opencode) — agent config,
 *   settings, skills, hooks, commands, agents
 *
 * Usage:
 *   import { getPaiDir, getFrameworkDir, getClaudeDir, paiPath } from '';
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';

/**
 * Expand shell variables in a path string
 * Supports: $HOME, ${HOME}, ~
 */
export function expandPath(path: string): string {
  const home = homedir();

  return path
    .replace(/^\$HOME(?=\/|$)/, home)
    .replace(/^\$\{HOME\}(?=\/|$)/, home)
    .replace(/^~(?=\/|$)/, home);
}

type FrameworkState = {
  root?: string;
  dataDir?: string;
};

function readFrameworkState(): FrameworkState | null {
  try {
    const statePath = join(getDataDir(), 'framework.json');
    if (!existsSync(statePath)) return null;
    const parsed = JSON.parse(readFileSync(statePath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as FrameworkState;
  } catch {
    return null;
  }
}

/**
 * Get the PAI data directory (expanded)
 * Priority: PAI_DIR env var → shared framework state → legacy Claude path
 */
export function getPaiDir(): string {
  const envPaiDir = process.env.PAI_DIR;

  if (envPaiDir) {
    return expandPath(envPaiDir);
  }

  const frameworkRoot = readFrameworkState()?.root;
  if (frameworkRoot) return join(expandPath(frameworkRoot), 'PAI');

  return join(homedir(), '.claude', 'PAI');
}

/**
 * Get the shared PAI data directory.
 * MEMORY and USER live here so Claude, Codex, and OpenCode can share state.
 */
export function getDataDir(): string {
  const envDataDir = process.env.PAI_DATA_DIR;
  if (envDataDir) return expandPath(envDataDir);

  return join(homedir(), '.pai');
}

/**
 * Get the active framework home directory.
 * Priority: PAI_FRAMEWORK_DIR env var → shared framework state → parent of PAI_DIR → legacy Claude path
 */
export function getFrameworkDir(): string {
  const envFrameworkDir = process.env.PAI_FRAMEWORK_DIR;
  if (envFrameworkDir) return expandPath(envFrameworkDir);

  const frameworkRoot = readFrameworkState()?.root;
  if (frameworkRoot) return expandPath(frameworkRoot);

  const envPaiDir = process.env.PAI_DIR;
  if (envPaiDir) return resolve(expandPath(envPaiDir), '..');

  return join(homedir(), '.claude');
}

/**
 * Backward-compatible name for existing Claude-native hook code.
 */
export function getClaudeDir(): string {
  return getFrameworkDir();
}

/**
 * Get the active PAI settings path.
 */
export function getSettingsPath(): string {
  const envSettingsPath = process.env.PAI_SETTINGS_PATH;
  if (envSettingsPath) return expandPath(envSettingsPath);

  return join(getFrameworkDir(), 'settings.json');
}

/**
 * Get the authoritative .env path.
 * PAI_CONFIG_DIR/.env is global across frameworks; framework-root .env is a
 * compatibility fallback for older Claude-native installs.
 */
export function getEnvPath(): string {
  const envPath = process.env.PAI_ENV_PATH;
  if (envPath) return expandPath(envPath);

  const configDir = process.env.PAI_CONFIG_DIR;
  if (configDir) return join(expandPath(configDir), '.env');

  return join(getFrameworkDir(), '.env');
}

/**
 * Get a path relative to PAI_DIR
 */
export function paiPath(...segments: string[]): string {
  return join(getPaiDir(), ...segments);
}

/**
 * Get the hooks directory (lives in Claude home)
 */
export function getHooksDir(): string {
  return join(getFrameworkDir(), 'hooks');
}

/**
 * Get the skills directory (lives in Claude home)
 */
export function getSkillsDir(): string {
  return join(getFrameworkDir(), 'skills');
}

/**
 * Get the MEMORY directory
 */
export function getMemoryDir(): string {
  const memoryDir = process.env.PAI_MEMORY_DIR;
  if (memoryDir) return expandPath(memoryDir);

  return join(getDataDir(), 'MEMORY');
}

/**
 * Get the USER directory
 */
export function getUserDir(): string {
  const userDir = process.env.PAI_USER_DIR;
  if (userDir) return expandPath(userDir);

  return join(getDataDir(), 'USER');
}

/**
 * Get a path relative to shared MEMORY
 */
export function memoryPath(...segments: string[]): string {
  return join(getMemoryDir(), ...segments);
}

/**
 * Get a path relative to shared USER
 */
export function userPath(...segments: string[]): string {
  return join(getUserDir(), ...segments);
}
