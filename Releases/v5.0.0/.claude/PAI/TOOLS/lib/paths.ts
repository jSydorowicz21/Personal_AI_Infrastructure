import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

type FrameworkState = {
  root?: string;
  dataDir?: string;
};

export function homeDir(): string {
  const home = process.env.HOME;
  if (home && existsSync(home)) return home;
  const userProfile = process.env.USERPROFILE;
  if (userProfile && existsSync(userProfile)) return userProfile;
  return home || userProfile || homedir();
}

export function expandHome(value: string): string {
  const home = homeDir();
  return value
    .replace(/^~(?=\/|\\|$)/, home)
    .replace(/^\$HOME(?=\/|\\|$)/, home)
    .replace(/^\$\{HOME\}(?=\/|\\|$)/, home);
}

function readFrameworkStateAt(dataDir: string): FrameworkState | null {
  try {
    const statePath = join(dataDir, "framework.json");
    if (!existsSync(statePath)) return null;
    const parsed = JSON.parse(readFileSync(statePath, "utf-8"));
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as FrameworkState;
  } catch {
    return null;
  }
}

function readFrameworkState(): FrameworkState | null {
  const state = readFrameworkStateAt(getPaiDataDir());
  if (state?.root && !existsSync(expandHome(state.root))) return null;
  return state;
}

function normalizeFramework(value: string | undefined): string {
  return (value || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function activeFrameworkHomeEnv(): string {
  const framework = normalizeFramework(process.env.PAI_FRAMEWORK);
  if (framework === "codex" || framework === "openai" || framework === "openaicodex") return process.env.CODEX_HOME || "";
  if (framework === "opencode" || framework === "open") return process.env.OPENCODE_CONFIG_DIR || "";
  if (framework === "claude" || framework === "claudecode") return process.env.CLAUDE_HOME || process.env.PAI_CLAUDE_HOME || "";
  return "";
}

function matchesActiveFrameworkHome(path: string): boolean {
  const providerHome = activeFrameworkHomeEnv();
  return Boolean(providerHome && resolve(expandHome(providerHome)) === resolve(path));
}

function hasStaleFrameworkEnv(): boolean {
  if (process.env.PAI_FRAMEWORK_DIR) {
    const frameworkDir = expandHome(process.env.PAI_FRAMEWORK_DIR);
    return !existsSync(frameworkDir) && !matchesActiveFrameworkHome(frameworkDir);
  }
  if (process.env.PAI_DIR) {
    const paiDir = expandHome(process.env.PAI_DIR);
    const frameworkDir = process.env.PAI_FRAMEWORK_DIR ? expandHome(process.env.PAI_FRAMEWORK_DIR) : "";
    return !existsSync(paiDir) && !(frameworkDir && resolve(paiDir) === resolve(frameworkDir, "PAI") && matchesActiveFrameworkHome(frameworkDir));
  }
  return false;
}

export function getPaiDir(): string {
  const frameworkRoot = readFrameworkState()?.root;
  if (frameworkRoot) return join(expandHome(frameworkRoot), "PAI");
  if (process.env.PAI_DIR) {
    const envPaiDir = expandHome(process.env.PAI_DIR);
    if (existsSync(envPaiDir)) return envPaiDir;
  }
  return resolve(import.meta.dir, "..", "..");
}

export function getFrameworkDir(): string {
  const frameworkRoot = readFrameworkState()?.root;
  if (frameworkRoot) return expandHome(frameworkRoot);
  if (process.env.PAI_FRAMEWORK_DIR) {
    const envFrameworkDir = expandHome(process.env.PAI_FRAMEWORK_DIR);
    if (existsSync(envFrameworkDir)) return envFrameworkDir;
  }
  return resolve(getPaiDir(), "..");
}

export function getPaiDataDir(): string {
  const defaultDataDir = join(homeDir(), ".pai");
  const defaultState = readFrameworkStateAt(defaultDataDir);
  const defaultStateUsable = Boolean(defaultState?.root && existsSync(expandHome(defaultState.root)));
  if (process.env.PAI_DATA_DIR) {
    const envDataDir = expandHome(process.env.PAI_DATA_DIR);
    if (existsSync(envDataDir)) {
      const state = readFrameworkStateAt(envDataDir);
      if (!state && (!defaultStateUsable || !hasStaleFrameworkEnv())) return envDataDir;
      if (state?.root && existsSync(expandHome(state.root))) return envDataDir;
    }
    if (!defaultStateUsable || !hasStaleFrameworkEnv()) return envDataDir;
  }
  return defaultDataDir;
}

export function getConfigDir(): string {
  const envConfigDir = process.env.PAI_CONFIG_DIR ? expandHome(process.env.PAI_CONFIG_DIR) : "";
  if (envConfigDir && existsSync(envConfigDir)) return envConfigDir;
  return join(homeDir(), ".config", "PAI");
}

export function getEnvPath(): string {
  if (process.env.PAI_ENV_PATH) return expandHome(process.env.PAI_ENV_PATH);
  const configEnv = join(getConfigDir(), ".env");
  if (existsSync(configEnv)) return configEnv;
  return join(getFrameworkDir(), ".env");
}

export function getMemoryDir(): string {
  const envMemoryDir = process.env.PAI_MEMORY_DIR ? expandHome(process.env.PAI_MEMORY_DIR) : "";
  if (envMemoryDir && existsSync(envMemoryDir)) return envMemoryDir;
  return join(getPaiDataDir(), "MEMORY");
}

export function getUserDir(): string {
  const envUserDir = process.env.PAI_USER_DIR ? expandHome(process.env.PAI_USER_DIR) : "";
  if (envUserDir && existsSync(envUserDir)) return envUserDir;
  return join(getPaiDataDir(), "USER");
}

export function paiPath(...segments: string[]): string {
  return join(getPaiDir(), ...segments);
}

export function memoryPath(...segments: string[]): string {
  return join(getMemoryDir(), ...segments);
}

export function userPath(...segments: string[]): string {
  return join(getUserDir(), ...segments);
}
