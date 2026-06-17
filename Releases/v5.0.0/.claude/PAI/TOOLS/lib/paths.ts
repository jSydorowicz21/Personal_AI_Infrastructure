import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

type FrameworkState = {
  root?: string;
  dataDir?: string;
};

export function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

export function expandHome(value: string): string {
  const home = homeDir();
  return value
    .replace(/^~(?=\/|\\|$)/, home)
    .replace(/^\$HOME(?=\/|\\|$)/, home)
    .replace(/^\$\{HOME\}(?=\/|\\|$)/, home);
}

function readFrameworkState(): FrameworkState | null {
  try {
    const statePath = join(getPaiDataDir(), "framework.json");
    if (!existsSync(statePath)) return null;
    const parsed = JSON.parse(readFileSync(statePath, "utf-8"));
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as FrameworkState;
  } catch {
    return null;
  }
}

export function getPaiDir(): string {
  if (process.env.PAI_DIR) return expandHome(process.env.PAI_DIR);
  const frameworkRoot = readFrameworkState()?.root;
  if (frameworkRoot) return join(expandHome(frameworkRoot), "PAI");
  return resolve(import.meta.dir, "..", "..");
}

export function getFrameworkDir(): string {
  if (process.env.PAI_FRAMEWORK_DIR) return expandHome(process.env.PAI_FRAMEWORK_DIR);
  const frameworkRoot = readFrameworkState()?.root;
  if (frameworkRoot) return expandHome(frameworkRoot);
  return resolve(getPaiDir(), "..");
}

export function getPaiDataDir(): string {
  return expandHome(process.env.PAI_DATA_DIR || join(homeDir(), ".pai"));
}

export function getConfigDir(): string {
  return expandHome(process.env.PAI_CONFIG_DIR || join(homeDir(), ".config", "PAI"));
}

export function getEnvPath(): string {
  if (process.env.PAI_ENV_PATH) return expandHome(process.env.PAI_ENV_PATH);
  const configEnv = join(getConfigDir(), ".env");
  if (existsSync(configEnv)) return configEnv;
  return join(getFrameworkDir(), ".env");
}

export function getMemoryDir(): string {
  return expandHome(process.env.PAI_MEMORY_DIR || join(getPaiDataDir(), "MEMORY"));
}

export function getUserDir(): string {
  return expandHome(process.env.PAI_USER_DIR || join(getPaiDataDir(), "USER"));
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
