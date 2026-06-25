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
import { join, resolve, sep } from 'path';

export function homeDir(): string {
  const home = process.env.HOME;
  if (home && existsSync(home)) return home;
  const userProfile = process.env.USERPROFILE;
  if (userProfile && existsSync(userProfile)) return userProfile;
  return home || userProfile || homedir();
}

/**
 * Expand shell variables in a path string
 * Supports: $HOME, ${HOME}, ~
 */
export function expandPath(path: string): string {
  const home = homeDir();

  const expanded = path
    .replace(/^\$HOME(?=\/|\\|$)/, home)
    .replace(/^\$\{HOME\}(?=\/|\\|$)/, home)
    .replace(/^~(?=\/|\\|$)/, home);

  return sep === '\\' ? expanded : expanded.replace(/\\/g, sep);
}

type FrameworkState = {
  active?: string;
  framework?: string;
  root?: string;
  dataDir?: string;
};

function readFrameworkStateAt(dataDir: string): FrameworkState | null {
  try {
    const statePath = join(dataDir, 'framework.json');
    if (!existsSync(statePath)) return null;
    const parsed = JSON.parse(readFileSync(statePath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as FrameworkState;
  } catch {
    return null;
  }
}

function readFrameworkState(): FrameworkState | null {
  const state = readFrameworkStateAt(getDataDir());
  if (state?.root && !existsSync(expandPath(state.root))) return null;
  return state;
}

function normalizeFramework(value: string | undefined): string {
  return (value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function frameworkStateId(state: FrameworkState | null): string {
  return normalizeFramework(state?.active || state?.framework);
}

function canUseExplicitFrameworkRoot(state: FrameworkState | null, frameworkDir: string): boolean {
  const expanded = expandPath(frameworkDir);
  if (!existsSync(expanded)) return false;

  const stateRoot = state?.root ? resolve(expandPath(state.root)) : '';
  if (!stateRoot) return true;
  if (resolve(expanded) === stateRoot) return true;

  const explicitFramework = normalizeFramework(process.env.PAI_FRAMEWORK);
  const stateFramework = frameworkStateId(state);
  if (!explicitFramework) return false;
  if (stateFramework && explicitFramework === stateFramework) return false;

  return true;
}

function activeFrameworkHomeEnv(): string {
  const framework = normalizeFramework(process.env.PAI_FRAMEWORK);
  if (framework === 'codex' || framework === 'openai' || framework === 'openaicodex') return process.env.CODEX_HOME || '';
  if (framework === 'opencode' || framework === 'open') return process.env.OPENCODE_CONFIG_DIR || '';
  if (framework === 'claude' || framework === 'claudecode') return process.env.CLAUDE_HOME || process.env.PAI_CLAUDE_HOME || '';
  return '';
}

function activeFrameworkRootFromEnv(state: FrameworkState | null, requirePaiDir = false): string {
  const providerHome = activeFrameworkHomeEnv();
  if (!providerHome) return '';
  const expanded = expandPath(providerHome);
  if (!existsSync(expanded)) return '';
  if (requirePaiDir && !existsSync(join(expanded, 'PAI'))) return '';
  if (!canUseExplicitFrameworkRoot(state, expanded)) return '';
  return expanded;
}

function matchesActiveFrameworkHome(path: string): boolean {
  const providerHome = activeFrameworkHomeEnv();
  return Boolean(providerHome && resolve(expandPath(providerHome)) === resolve(path));
}

function hasStaleFrameworkEnv(): boolean {
  const envFrameworkDir = process.env.PAI_FRAMEWORK_DIR;
  if (envFrameworkDir) {
    const expanded = expandPath(envFrameworkDir);
    return !existsSync(expanded) && !matchesActiveFrameworkHome(expanded);
  }
  const envPaiDir = process.env.PAI_DIR;
  if (envPaiDir) {
    const expanded = expandPath(envPaiDir);
    const frameworkDir = process.env.PAI_FRAMEWORK_DIR ? expandPath(process.env.PAI_FRAMEWORK_DIR) : '';
    return !existsSync(expanded) && !(frameworkDir && resolve(expanded) === resolve(frameworkDir, 'PAI') && matchesActiveFrameworkHome(frameworkDir));
  }
  return false;
}

/**
 * Get the PAI data directory (expanded)
 * Priority: shared framework state → existing PAI_DIR env var → legacy Claude path
 */
export function getPaiDir(): string {
  const state = readFrameworkState();
  const envPaiDir = process.env.PAI_DIR;
  if (envPaiDir) {
    const expanded = expandPath(envPaiDir);
    if (existsSync(expanded) && canUseExplicitFrameworkRoot(state, resolve(expanded, '..'))) return expanded;
  }

  const envFrameworkDir = process.env.PAI_FRAMEWORK_DIR;
  if (envFrameworkDir) {
    const expanded = expandPath(envFrameworkDir);
    const paiDir = join(expanded, 'PAI');
    if (existsSync(expanded) && existsSync(paiDir) && canUseExplicitFrameworkRoot(state, expanded)) return paiDir;
  }

  const providerFrameworkDir = activeFrameworkRootFromEnv(state, true);
  if (providerFrameworkDir) return join(providerFrameworkDir, 'PAI');

  const frameworkRoot = state?.root;
  if (frameworkRoot) return join(expandPath(frameworkRoot), 'PAI');

  return join(homeDir(), '.claude', 'PAI');
}

/**
 * Get the shared PAI data directory.
 * MEMORY and USER live here so Claude, Codex, and OpenCode can share state.
 */
export function getDataDir(): string {
  const defaultDataDir = join(homeDir(), '.pai');
  const defaultState = readFrameworkStateAt(defaultDataDir);
  const defaultStateUsable = Boolean(defaultState?.root && existsSync(expandPath(defaultState.root)));
  const envDataDir = process.env.PAI_DATA_DIR;
  if (envDataDir) {
    const expanded = expandPath(envDataDir);
    if (existsSync(expanded)) {
      const state = readFrameworkStateAt(expanded);
      if (!state && (!defaultStateUsable || !hasStaleFrameworkEnv())) return expanded;
      if (state) {
        if (state.root && existsSync(expandPath(state.root))) return expanded;
        if (defaultStateUsable) return defaultDataDir;
        return expanded;
      }
    }
    if (!defaultStateUsable || !hasStaleFrameworkEnv()) return expanded;
  }

  return defaultDataDir;
}

/**
 * Get the active framework home directory.
 * Priority: shared framework state → existing PAI_FRAMEWORK_DIR env var → parent of existing PAI_DIR → legacy Claude path
 */
export function getFrameworkDir(): string {
  const state = readFrameworkState();
  const envFrameworkDir = process.env.PAI_FRAMEWORK_DIR;
  if (envFrameworkDir) {
    const expanded = expandPath(envFrameworkDir);
    if (existsSync(expanded) && canUseExplicitFrameworkRoot(state, expanded)) return expanded;
  }

  const envPaiDir = process.env.PAI_DIR;
  if (envPaiDir) {
    const expanded = expandPath(envPaiDir);
    const frameworkDir = resolve(expanded, '..');
    if (existsSync(expanded) && canUseExplicitFrameworkRoot(state, frameworkDir)) return frameworkDir;
  }

  const providerFrameworkDir = activeFrameworkRootFromEnv(state);
  if (providerFrameworkDir) return providerFrameworkDir;

  const frameworkRoot = state?.root;
  if (frameworkRoot) return expandPath(frameworkRoot);

  return join(homeDir(), '.claude');
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
  if (configDir) {
    const configEnv = join(expandPath(configDir), '.env');
    if (existsSync(configEnv)) return configEnv;
  }

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
  if (memoryDir) {
    const expanded = expandPath(memoryDir);
    if (existsSync(expanded)) return expanded;
  }

  return join(getDataDir(), 'MEMORY');
}

/**
 * Get the USER directory
 */
export function getUserDir(): string {
  const userDir = process.env.PAI_USER_DIR;
  if (userDir) {
    const expanded = expandPath(userDir);
    if (existsSync(expanded)) return expanded;
  }

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
