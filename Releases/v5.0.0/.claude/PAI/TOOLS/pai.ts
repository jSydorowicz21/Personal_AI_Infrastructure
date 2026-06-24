#!/usr/bin/env bun
/**
 * pai - Personal AI CLI Tool
 *
 * Comprehensive CLI for managing PAI across Claude Code, Codex, and OpenCode,
 * with dynamic MCP loading,
 * updates, version checking, and profile management.
 *
 * Usage:
 *   pai                  Launch active framework (default profile)
 *   pai -m bd            Launch with Bright Data MCP
 *   pai -m bd,ap         Launch with multiple MCPs
 *   pai -r / --resume    Resume last session
 *   pai --local          Compatibility flag; launches already stay in current directory
 *   pai update           Update active framework CLI
 *   pai version          Show version info
 *   pai profiles         List available profiles
 *   pai mcp list         List available MCPs
 *   pai mcp set <profile>  Set MCP profile
 *   pai doctor           Verify local PAI runtime health
 *   pai memory delete    Delete a memory file and redact local cache/log copies
 */

import { spawn, spawnSync } from "bun";
import { appendFileSync, existsSync, readFileSync, writeFileSync, readdirSync, symlinkSync, unlinkSync, rmdirSync, lstatSync, mkdirSync, cpSync, rmSync, realpathSync } from "fs";
import { join, basename, dirname, delimiter, extname, resolve } from "path";
import { generateCodexHooksJson, mergeOpenCodeConfigJson } from "../PAI-Install/engine/config-gen";
import { renderPaiAgentInstructions, slugifyPaiAgentName } from "./lib/provider-agent-renderer";
import { expandHome as expandPaiHome, getConfigDir, getPaiDataDir, homeDir as resolveHomeDir } from "./lib/paths";

// ============================================================================
// Configuration
// ============================================================================

type FrameworkId = "claude" | "codex" | "opencode";

const HOME = resolveHomeDir();
const CURRENT_PAI_DIR = join(import.meta.dir, "..");
const CURRENT_INSTALL_ROOT = join(CURRENT_PAI_DIR, "..");
const DATA_DIR = getPaiDataDir();
const CONFIG_DIR = getConfigDir();
const FRAMEWORK_STATE = join(DATA_DIR, "framework.json");
const BANNER_SCRIPT = join(import.meta.dir, "Banner.ts");
const VOICE_SERVER = "http://localhost:31337/notify/personality";
const WALLPAPER_DIR = join(HOME, "Projects", "Wallpaper");
// Note: RAW archiving removed - Claude Code handles its own cleanup (30-day retention in projects/)

// MCP shorthand mappings
const MCP_SHORTCUTS: Record<string, string> = {
  bd: "Brightdata-MCP.json",
  brightdata: "Brightdata-MCP.json",
  ap: "Apify-MCP.json",
  apify: "Apify-MCP.json",
  cu: "ClickUp-MCP.json",
  clickup: "ClickUp-MCP.json",
  dev: "dev-work.mcp.json",
  sec: "security.mcp.json",
  security: "security.mcp.json",
  research: "research.mcp.json",
  full: "full.mcp.json",
  min: "minimal.mcp.json",
  minimal: "minimal.mcp.json",
  none: "none.mcp.json",
};

// Profile descriptions
const PROFILE_DESCRIPTIONS: Record<string, string> = {
  none: "No MCPs (maximum performance)",
  minimal: "No external MCPs; base PAI tools only",
  "dev-work": "Development tools (Shadcn, Supabase)",
  security: "Reserved security profile; no bundled external MCPs",
  research: "Research tools (Brightdata, Apify)",
  clickup: "Official ClickUp MCP (tasks, time tracking, docs)",
  full: "All available MCPs",
};

// ============================================================================
// Utilities
// ============================================================================

function log(message: string, emoji = "") {
  console.log(emoji ? `${emoji} ${message}` : message);
}


function error(message: string) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

function readFrameworkState(): { active?: FrameworkId; framework?: FrameworkId; root?: string; dataDir?: string } | null {
  try {
    if (!existsSync(FRAMEWORK_STATE)) return null;
    const parsed = JSON.parse(readFileSync(FRAMEWORK_STATE, "utf-8"));
    const active = normalizeFramework(parsed.active);
    const framework = normalizeFramework(parsed.framework);
    return {
      active: active || undefined,
      framework: framework || undefined,
      root: typeof parsed.root === "string" ? parsed.root : undefined,
      dataDir: typeof parsed.dataDir === "string" ? parsed.dataDir : undefined,
    };
  } catch {
    return null;
  }
}

function getSettingsPath(): string {
  if (process.env.PAI_SETTINGS_PATH) return process.env.PAI_SETTINGS_PATH;
  const state = readFrameworkState();
  if (state?.root) return join(state.root, "settings.json");
  return join(CURRENT_INSTALL_ROOT, "settings.json");
}

function readSettings(): Record<string, any> {
  try {
    const path = getSettingsPath();
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

function getIdentity() {
  const settings = readSettings();
  const daidentity = settings.daidentity || {};
  const voices = daidentity.voices || {};
  const voiceConfig = voices.main || daidentity.voice;
  return {
    name: daidentity.name || settings.env?.DA || "PAI",
    personality: daidentity.personality,
    mainDAVoiceID: voiceConfig?.voiceId || daidentity.voiceId || "",
  };
}

function getStartupCatchphrase(): string {
  const settings = readSettings();
  const name = getIdentity().name;
  const template = settings.daidentity?.startupCatchphrase || "{name} here, ready to go.";
  return template.replace(/\{name\}/gi, name);
}

function frameworkRoot(id: FrameworkId): string {
  const state = readFrameworkState();
  const stateFramework = state?.active || state?.framework;
  if (state?.root && stateFramework === id && existsSync(expandPaiHome(state.root))) return expandPaiHome(state.root);
  const envFramework = normalizeFramework(process.env.PAI_FRAMEWORK);
  const switchTarget = normalizeFramework(process.argv[4]);
  const canCreateEnvRoot = process.argv[2] === "framework" && process.argv[3] === "switch" && switchTarget === id;
  if (id === "codex" && process.env.CODEX_HOME) {
    const codexHome = expandPaiHome(process.env.CODEX_HOME);
    if (existsSync(codexHome) || canCreateEnvRoot) return codexHome;
  }
  if (id === "opencode" && process.env.OPENCODE_CONFIG_DIR) {
    const opencodeHome = expandPaiHome(process.env.OPENCODE_CONFIG_DIR);
    if (existsSync(opencodeHome) || canCreateEnvRoot) return opencodeHome;
  }
  const claudeHome = process.env.CLAUDE_HOME || process.env.PAI_CLAUDE_HOME;
  if (id === "claude" && claudeHome) {
    const expandedClaudeHome = expandPaiHome(claudeHome);
    if (existsSync(expandedClaudeHome) || canCreateEnvRoot) return expandedClaudeHome;
  }
  const frameworkDirOverride = process.env.PAI_FRAMEWORK_DIR;
  if (frameworkDirOverride && envFramework === id) {
    const expandedFrameworkDir = expandPaiHome(frameworkDirOverride);
    if (existsSync(expandedFrameworkDir) || canCreateEnvRoot) return expandedFrameworkDir;
  }
  if (id === "codex") return join(HOME, ".codex");
  if (id === "opencode") return join(HOME, ".config", "opencode");
  return join(HOME, ".claude");
}

function frameworkCommand(id: FrameworkId): string {
  if (id === "codex") return "codex";
  if (id === "opencode") return "opencode";
  return "claude";
}

function resolveWindowsCommand(command: string): string {
  if (process.platform !== "win32") return command;
  if (command.includes("\\") || command.includes("/") || extname(command)) return command;

  const pathEntries = (process.env.PATH || process.env.Path || process.env.path || "").split(delimiter).filter(Boolean);
  const pathExts = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.toLowerCase());
  const candidateExts = [".cmd", ".exe", ".bat", "", ...pathExts]
    .filter((ext, index, all) => all.indexOf(ext) === index);

  for (const dir of pathEntries) {
    for (const ext of candidateExts) {
      const candidate = join(dir, `${command}${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }

  return command;
}

function quoteCmdArg(value: string): string {
  if (value === "") return "\"\"";
  if (!/[ \t&()^|<>"%]/.test(value)) return value;
  return `"${value.replace(/"/g, "\"\"").replace(/%/g, "%%")}"`;
}

function frameworkSpawnArgs(args: string[]): string[] {
  if (process.platform !== "win32") return args;

  const command = resolveWindowsCommand(args[0]);
  const ext = extname(command).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat") return [command, ...args.slice(1)];

  const cmd = process.env.ComSpec || "cmd.exe";
  const line = [command, ...args.slice(1)].map(quoteCmdArg).join(" ");
  return [cmd, "/d", "/s", "/c", line];
}

function frameworkName(id: FrameworkId): string {
  if (id === "codex") return "Codex";
  if (id === "opencode") return "OpenCode";
  return "Claude Code";
}

function frameworkCliPackage(id: FrameworkId): string {
  if (id === "codex") return "@openai/codex";
  if (id === "opencode") return "opencode-ai";
  return "@anthropic-ai/claude-code";
}

function getGlobalCliPackageVersion(packageName: string): string | null {
  const nodeModuleRoots = [
    process.env.NPM_CONFIG_PREFIX ? join(process.env.NPM_CONFIG_PREFIX, "node_modules") : "",
    process.env.APPDATA ? join(process.env.APPDATA, "npm", "node_modules") : "",
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "npm", "node_modules") : "",
  ].filter(Boolean);

  for (const root of nodeModuleRoots) {
    const packageJson = join(root, ...packageName.split("/"), "package.json");
    if (!existsSync(packageJson)) continue;
    try {
      const parsed = JSON.parse(readFileSync(packageJson, "utf-8")) as { version?: unknown };
      if (typeof parsed.version === "string" && parsed.version.trim()) return parsed.version.trim();
    } catch {}
  }

  return null;
}

function normalizeFramework(value: string | undefined): FrameworkId | null {
  const v = (value || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (v === "claude" || v === "claudecode") return "claude";
  if (v === "codex" || v === "openai" || v === "openaicodex") return "codex";
  if (v === "opencode" || v === "open") return "opencode";
  return null;
}

function getActiveFramework(): FrameworkId {
  const state = readFrameworkState();
  if (state?.active || state?.framework) return state.active || state.framework || "claude";
  const settings = readSettings();
  return normalizeFramework(settings.pai?.framework) || normalizeFramework(process.env.PAI_FRAMEWORK) || "claude";
}

// Remove a symlink/junction destination WITHOUT recursing into (and deleting)
// its target. A recursive rmSync on a directory junction can delete the real
// source tree it points at; in dev installs the framework dirs are junctions
// back into the source repo, so this guard keeps regeneration non-destructive.
function removeLinkOnly(target: string): void {
  if (!existsSync(target) && !isSymbolicLinkSafe(target)) return;
  if (isSymbolicLinkSafe(target)) {
    try {
      unlinkSync(target);
      return;
    } catch {
      // Directory junctions (Windows) reject unlink; rmdir removes the link only.
      try {
        rmdirSync(target);
        return;
      } catch {
        // Fall through to a guarded recursive remove as a last resort.
      }
    }
  }
  rmSync(target, { recursive: true, force: true });
}

function isSymbolicLinkSafe(target: string): boolean {
  try {
    return lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

function copyMissing(src: string, dst: string): number {
  let copied = 0;
  if (!existsSync(src)) return copied;
  const stat = lstatSync(src);
  if (stat.isFile()) {
    if (!existsSync(dst)) {
      mkdirSync(dirname(dst), { recursive: true });
      cpSync(src, dst);
      copied++;
    }
    return copied;
  }
  if (stat.isDirectory()) {
    mkdirSync(dst, { recursive: true });
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      copied += copyMissing(join(src, entry.name), join(dst, entry.name));
    }
  }
  return copied;
}

function linkDirectory(localPath: string, globalPath: string): number {
  mkdirSync(dirname(localPath), { recursive: true });
  mkdirSync(globalPath, { recursive: true });
  if (existsSync(localPath)) {
    const stat = lstatSync(localPath);
    if (stat.isSymbolicLink()) {
      try {
        if (realpathSync(localPath) === realpathSync(globalPath)) return 0;
      } catch {
        // Broken or inaccessible links are replaced below.
      }
      removeLinkOnly(localPath);
      symlinkSync(globalPath, localPath, process.platform === "win32" ? "junction" : "dir");
      return 0;
    }
    const copied = copyMissing(localPath, globalPath);
    rmSync(localPath, { recursive: true, force: true });
    symlinkSync(globalPath, localPath, process.platform === "win32" ? "junction" : "dir");
    return copied;
  }
  symlinkSync(globalPath, localPath, process.platform === "win32" ? "junction" : "dir");
  return 0;
}

function createDirectoryLink(src: string, dst: string) {
  symlinkSync(src, dst, process.platform === "win32" ? "junction" : "dir");
}

function syncManagedPaiEntry(src: string, dst: string) {
  if (resolve(src) === resolve(dst)) return;
  const sourceStat = lstatSync(src);
  if (existsSync(dst)) {
    try {
      if (realpathSync(dst) === realpathSync(src)) return;
    } catch {
      // Broken links or inaccessible targets are replaced below.
    }
    try {
      rmSync(dst, { recursive: true, force: true });
    } catch (err) {
      if (sourceStat.isDirectory() && existsSync(dst) && lstatSync(dst).isDirectory()) {
        cpSync(src, dst, { recursive: true, force: true });
        return;
      }
      throw err;
    }
  }
  mkdirSync(dirname(dst), { recursive: true });
  if (sourceStat.isDirectory()) createDirectoryLink(src, dst);
  else if (sourceStat.isFile()) cpSync(src, dst);
}

function syncManagedFrameworkDirectory(src: string, dst: string) {
  if (!existsSync(src)) return;
  if (resolve(src) === resolve(dst)) return;
  if (!existsSync(dst)) {
    createDirectoryLink(src, dst);
    return;
  }
  try {
    if (realpathSync(dst) === realpathSync(src)) return;
  } catch {
    // Broken links or inaccessible targets are replaced below.
  }
  const stat = lstatSync(dst);
  if (stat.isSymbolicLink()) {
    removeLinkOnly(dst);
    createDirectoryLink(src, dst);
    return;
  }
  cpSync(src, dst, { recursive: true, force: true });
}

function syncCodexPrompts(root: string): number {
  const commandsDir = join(root, "commands");
  const promptsDir = join(root, "prompts");
  if (!existsSync(commandsDir)) return 0;

  if (existsSync(promptsDir) && lstatSync(promptsDir).isSymbolicLink()) {
    removeLinkOnly(promptsDir);
  }
  mkdirSync(promptsDir, { recursive: true });

  let written = 0;
  for (const entry of readdirSync(commandsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const dst = join(promptsDir, entry.name);
    if (existsSync(dst) && !shouldReplaceGeneratedPaiFile(dst)) continue;
    const { frontmatter, body } = parseMarkdownFrontmatter(readFileSync(join(commandsDir, entry.name), "utf-8"));
    writeFileSync(dst, codexPromptContent(frontmatter.description || `PAI ${basename(entry.name, ".md")} command.`, body));
    written++;
  }
  return written;
}

function parseMarkdownFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return { frontmatter: {}, body: content };
  }

  const normalized = content.replace(/\r\n/g, "\n");
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1) return { frontmatter: {}, body: content };

  const frontmatter: Record<string, string> = {};
  for (const line of normalized.slice(4, end).split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const raw = match[2].trim();
    if (!raw) continue;
    frontmatter[match[1]] = raw.replace(/^["']|["']$/g, "");
  }

  return { frontmatter, body: normalized.slice(end + "\n---\n".length) };
}

function codexPromptContent(description: string, body: string): string {
  const adaptedBody = body
    .replace(/Use the Skill tool to invoke ([A-Za-z0-9_-]+) with the provided arguments:/g, "Invoke the $$$1 skill with the provided arguments:")
    .replace(/Skill\("([A-Za-z0-9_-]+)",\s*"\$ARGUMENTS"\)/g, "$$$1 $ARGUMENTS")
    .replace(/\bClaude Code\b/g, "Codex");

  return [
    "---",
    `description: ${yamlString(description)}`,
    "---",
    "",
    "This PAI prompt was generated for Codex from the shared PAI command definition.",
    "",
    adaptedBody,
    "",
  ].join("\n");
}

function frameworkInstructionContent(content: string, id: FrameworkId): string {
  const framework = frameworkName(id);
  return content
    .replace(/\bCLAUDE\.md\b/g, id === "claude" ? "CLAUDE.md" : "AGENTS.md")
    .replace(/\bClaude Code\b/g, framework)
    .replace(/~\/\.claude\/PAI/g, "$PAI_DIR")
    .replace(/~\/\.claude/g, "$PAI_FRAMEWORK_DIR")
    .replace(/\$PAI_FRAMEWORK_DIR\/PAI/g, "$PAI_DIR");
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function syncCodexAgents(root: string): number {
  let sourceDir = join(CURRENT_INSTALL_ROOT, "agents");
  if (!existsSync(sourceDir)) return 0;

  const agentsDir = join(root, "agents");
  if (existsSync(agentsDir)) {
    const stat = lstatSync(agentsDir);
    if (stat.isSymbolicLink()) {
      sourceDir = realpathSync(sourceDir);
      removeLinkOnly(agentsDir);
    }
  }
  mkdirSync(agentsDir, { recursive: true });

  let written = 0;
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const sourcePath = join(sourceDir, entry.name);
    const { frontmatter, body } = parseMarkdownFrontmatter(readFileSync(sourcePath, "utf-8"));
    const name = frontmatter.name || basename(entry.name, ".md");
    const dst = join(agentsDir, `${slugifyPaiAgentName(name)}.toml`);
    if (existsSync(dst) && !shouldReplaceGeneratedPaiFile(dst)) continue;
    const description = frontmatter.description || `PAI ${name} agent.`;
    const instructions = renderPaiAgentInstructions("codex", {
      name,
      description,
      initialPrompt: frontmatter.initialPrompt,
      body,
    });
    writeFileSync(dst, [
      `name = ${JSON.stringify(name)}`,
      `description = ${JSON.stringify(description)}`,
      `developer_instructions = ${JSON.stringify(instructions)}`,
      "",
    ].join("\n"));
    written++;
  }
  return written;
}

function shouldReplaceGeneratedPaiFile(path: string): boolean {
  if (!existsSync(path)) return true;
  try {
    const content = readFileSync(path, "utf-8");
    return content.includes("This PAI agent was generated")
      || content.includes("This PAI agent was rendered")
      || content.includes("This PAI command was generated")
      || content.includes("This PAI prompt was generated")
      || content.includes('Skill("')
      || content.includes("initialPrompt:")
      || content.includes("argument-hint:")
      || content.includes("This command has been migrated to");
  } catch {
    return false;
  }
}

function syncOpenCodeAgents(root: string): number {
  let sourceDir = join(CURRENT_INSTALL_ROOT, "agents");
  if (!existsSync(sourceDir)) return 0;

  const agentsDir = join(root, "agents");
  if (existsSync(agentsDir)) {
    const stat = lstatSync(agentsDir);
    if (stat.isSymbolicLink()) {
      sourceDir = realpathSync(sourceDir);
      removeLinkOnly(agentsDir);
    }
  }
  mkdirSync(agentsDir, { recursive: true });

  let written = 0;
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const sourcePath = join(sourceDir, entry.name);
    const { frontmatter, body } = parseMarkdownFrontmatter(readFileSync(sourcePath, "utf-8"));
    const name = frontmatter.name || basename(entry.name, ".md");
    const dst = join(agentsDir, entry.name);
    if (!shouldReplaceGeneratedPaiFile(dst)) continue;
    writeFileSync(dst, [
      "---",
      `description: ${yamlString(frontmatter.description || `PAI ${name} agent.`)}`,
      "mode: subagent",
      "---",
      "",
      renderPaiAgentInstructions("opencode", {
        name,
        description: frontmatter.description || `PAI ${name} agent.`,
        initialPrompt: frontmatter.initialPrompt,
        body,
      }),
      "",
    ].join("\n"));
    written++;
  }
  return written;
}

function syncOpenCodeCommands(root: string): number {
  let sourceDir = join(CURRENT_INSTALL_ROOT, "commands");
  if (!existsSync(sourceDir)) return 0;

  const commandsDir = join(root, "commands");
  if (existsSync(commandsDir)) {
    const stat = lstatSync(commandsDir);
    if (stat.isSymbolicLink()) {
      sourceDir = realpathSync(sourceDir);
      removeLinkOnly(commandsDir);
    }
  }
  mkdirSync(commandsDir, { recursive: true });

  let written = 0;
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const sourcePath = join(sourceDir, entry.name);
    const { frontmatter, body } = parseMarkdownFrontmatter(readFileSync(sourcePath, "utf-8"));
    const dst = join(commandsDir, entry.name);
    if (!shouldReplaceGeneratedPaiFile(dst)) continue;
    writeFileSync(dst, [
      "---",
      `description: ${yamlString(frontmatter.description || `PAI ${basename(entry.name, ".md")} command.`)}`,
      "---",
      "",
      "This PAI command was generated for OpenCode from the shared PAI command definition.",
      "",
      body
        .replace(/Use the Skill tool to invoke ([A-Za-z0-9_-]+) with the provided arguments:/g, "Invoke the $$$1 skill with the provided arguments:")
        .replace(/Skill\("([A-Za-z0-9_-]+)",\s*"\$ARGUMENTS"\)/g, "$$$1 $ARGUMENTS")
        .replace(/\bSkill tool\b/g, "OpenCode skill tool")
        .replace(/\bClaude Code\b/g, "OpenCode"),
      "",
    ].join("\n"));
    written++;
  }
  return written;
}

function getMcpDir(): string {
  const candidates = [
    join(CURRENT_INSTALL_ROOT, "MCPs"),
    join(CURRENT_PAI_DIR, "MCPs"),
    join(CURRENT_INSTALL_ROOT, "PAI", "MCPs"),
  ];
  return candidates.find((path) => existsSync(path)) || candidates[0];
}

function activeMcpPath(root = CURRENT_INSTALL_ROOT): string {
  return join(root, ".mcp.json");
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function powerShellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function powerShellEncodedCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function frameworkEnv(root: string, id: FrameworkId): Record<string, string> {
  return {
    PAI_DIR: join(root, "PAI"),
    PAI_DATA_DIR: DATA_DIR,
    PAI_FRAMEWORK: id,
    PAI_FRAMEWORK_DIR: root,
    PAI_SETTINGS_PATH: join(root, "settings.json"),
    PAI_CONFIG_DIR: CONFIG_DIR,
  };
}

function setWindowsPaiUserEnvironment(root: string, id: FrameworkId): boolean {
  if (process.platform !== "win32" || process.env.PAI_SKIP_USER_ENV_UPDATE === "1") return true;

  const env = frameworkEnv(root, id);
  Object.assign(process.env, env);

  const target = process.env.PAI_USER_ENV_TARGET === "Process" ? "Process" : "User";
  const script = [
    `$target = '${target}'`,
    ...Object.entries(env).map(([key, value]) =>
      `[Environment]::SetEnvironmentVariable('${key}', ${powerShellSingleQuote(value)}, $target)`
    ),
    "if ($target -eq 'User') {",
    "  try {",
    `    Add-Type -Namespace Pai.Native -Name User32 -MemberDefinition @'
[DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)]
public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out System.UIntPtr lpdwResult);
'@ -ErrorAction SilentlyContinue`,
    "    $result = [UIntPtr]::Zero",
    "    [Pai.Native.User32]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result) | Out-Null",
    "  } catch {}",
    "}",
  ].join("\n");
  const result = spawnSync([
    "powershell",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ]);

  return result.exitCode === 0;
}

function codexHookCommand(root: string, hookFile: string): string {
  const env = frameworkEnv(root, "codex");
  const adapter = join(root, "hooks", "FrameworkHookAdapter.ts");
  return [
    ...Object.entries(env).map(([key, value]) => `${key}=${shellSingleQuote(value)}`),
    "bun",
    shellSingleQuote(adapter),
    "--framework",
    "'codex'",
    "--target",
    shellSingleQuote(hookFile),
  ].join(" ");
}

function codexHookCommandWindows(root: string, hookFile: string): string {
  const env = frameworkEnv(root, "codex");
  const adapter = join(root, "hooks", "FrameworkHookAdapter.ts");
  const envAssignments = Object.entries(env)
    .map(([key, value]) => `$env:${key}=${powerShellSingleQuote(value)};`)
    .join(" ");
  const script = `${envAssignments} bun ${powerShellSingleQuote(adapter)} --framework 'codex' --target ${powerShellSingleQuote(hookFile)}`;
  return [
    "powershell",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    powerShellEncodedCommand(script),
  ].join(" ");
}

function codexCommandHook(root: string, hookFile: string, timeout = 10): Record<string, any> {
  return {
    type: "command",
    command: codexHookCommand(root, hookFile),
    commandWindows: codexHookCommandWindows(root, hookFile),
    timeout,
  };
}

function generateCodexHooks(root: string): Record<string, any> {
  return generateCodexHooksJson({
    framework: "codex",
    principalName: "",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    aiName: "PAI",
    catchphrase: "",
    paiDir: root,
    configDir: CONFIG_DIR,
    dataDir: DATA_DIR,
  });
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: unknown[]): string {
  return `[${values.map((value) => tomlString(String(value))).join(", ")}]`;
}

function tomlScalar(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : tomlString(String(value));
  return tomlString(String(value));
}

function tomlTable(name: string, table: Record<string, unknown>): string[] {
  const lines = [`[${name}]`];
  for (const [key, value] of Object.entries(table)) {
    if (value === undefined || value === null) continue;
    lines.push(`${key} = ${tomlScalar(value)}`);
  }
  return lines;
}

function safeMcpName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

const CODEX_ROOT_BEGIN = "# BEGIN PAI MANAGED ROOT CONFIG";
const CODEX_ROOT_END = "# END PAI MANAGED ROOT CONFIG";
const CODEX_MCP_BEGIN = "# BEGIN PAI MANAGED MCP CONFIG";
const CODEX_MCP_END = "# END PAI MANAGED MCP CONFIG";

function stripManagedTomlBlocks(content: string): string {
  return content
    .replace(new RegExp(`\\n?${CODEX_ROOT_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${CODEX_ROOT_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`, "g"), "\n")
    .replace(new RegExp(`\\n?${CODEX_MCP_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${CODEX_MCP_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`, "g"), "\n")
    .trim();
}

function firstTomlTableIndex(content: string): number {
  const match = content.match(/^\[.+\]\s*$/m);
  return match?.index ?? content.length;
}

function rootTomlHasKey(content: string, key: string): boolean {
  const root = content.slice(0, firstTomlTableIndex(content));
  return new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`, "m").test(root);
}

function existingMcpTableNames(content: string): Set<string> {
  const names = new Set<string>();
  const stripped = stripManagedTomlBlocks(content);
  const pattern = /^\[mcp_servers\.([^\].]+)\]/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(stripped))) names.add(match[1]);
  return names;
}

function isLegacyPaiOnlyCodexConfig(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed.startsWith("# Generated by PAI.") && !trimmed.startsWith("# Generated by the PAI installer.")) return false;
  return !/^\[(?!mcp_servers\.)/m.test(trimmed);
}

function codexRootConfigToml(existing = ""): string {
  const lines = [
    CODEX_ROOT_BEGIN,
    "# PAI uses AGENTS.md plus RTK.md for Codex instructions.",
    "# PAI hooks are written to hooks.json.",
  ];
  if (!rootTomlHasKey(existing, "project_doc_fallback_filenames")) {
    lines.push("project_doc_fallback_filenames = [\"AGENTS.md\", \"RTK.md\", \"CLAUDE.md\"]");
  }
  if (!rootTomlHasKey(existing, "project_doc_max_bytes")) {
    lines.push("project_doc_max_bytes = 65536");
  }
  if (!rootTomlHasKey(existing, "model")) {
    lines.push('model = "gpt-5.5"');
  }
  if (!rootTomlHasKey(existing, "model_reasoning_effort")) {
    lines.push('model_reasoning_effort = "high"');
  }
  if (!rootTomlHasKey(existing, "plan_mode_reasoning_effort")) {
    lines.push('plan_mode_reasoning_effort = "xhigh"');
  }
  lines.push(CODEX_ROOT_END);
  return lines.join("\n");
}

function buildCodexMcpConfigToml(mcpConfig?: Record<string, any>, skipNames = new Set<string>()): string {
  const lines = [
    CODEX_MCP_BEGIN,
  ];

  const servers = mcpConfig?.mcpServers || {};
  for (const [rawName, server] of Object.entries(servers) as Array<[string, any]>) {
    const name = safeMcpName(rawName);
    if (skipNames.has(name)) continue;
    lines.push(`[mcp_servers.${name}]`);
    if (server.url) {
      lines.push(`url = ${tomlString(server.url)}`);
      if (server.bearer_token_env_var) lines.push(`bearer_token_env_var = ${tomlString(server.bearer_token_env_var)}`);
      if (server.startup_timeout_sec) lines.push(`startup_timeout_sec = ${tomlScalar(server.startup_timeout_sec)}`);
      if (server.tool_timeout_sec) lines.push(`tool_timeout_sec = ${tomlScalar(server.tool_timeout_sec)}`);
      if (server.enabled === false) lines.push("enabled = false");
      if (server.http_headers && typeof server.http_headers === "object") {
        lines.push(...tomlTable(`mcp_servers.${name}.http_headers`, server.http_headers));
      }
      if (server.env_http_headers && typeof server.env_http_headers === "object") {
        lines.push(...tomlTable(`mcp_servers.${name}.env_http_headers`, server.env_http_headers));
      }
    } else if (server.command) {
      lines.push(`command = ${tomlString(server.command)}`);
      if (Array.isArray(server.args)) lines.push(`args = ${tomlArray(server.args)}`);
      if (server.cwd) lines.push(`cwd = ${tomlString(server.cwd)}`);
      if (server.startup_timeout_sec) lines.push(`startup_timeout_sec = ${tomlScalar(server.startup_timeout_sec)}`);
      if (server.tool_timeout_sec) lines.push(`tool_timeout_sec = ${tomlScalar(server.tool_timeout_sec)}`);
      if (server.enabled === false) lines.push("enabled = false");
      if (server.env && typeof server.env === "object") {
        lines.push(...tomlTable(`mcp_servers.${name}.env`, server.env));
      }
      if (Array.isArray(server.env_vars)) {
        const stringVars = server.env_vars.filter((item: unknown) => typeof item === "string");
        if (stringVars.length === server.env_vars.length) lines.push(`env_vars = ${tomlArray(stringVars)}`);
      }
    }
    lines.push("");
  }

  lines.push(CODEX_MCP_END);
  return lines.join("\n");
}

function buildCodexConfigToml(root: string, mcpConfig?: Record<string, any>): string {
  return [
    codexRootConfigToml(),
    "",
    buildCodexMcpConfigToml(mcpConfig),
    "",
  ].join("\n");
}

function mergeCodexConfigToml(existing: string, root: string, mcpConfig?: Record<string, any>): string {
  if (isLegacyPaiOnlyCodexConfig(existing)) return buildCodexConfigToml(root, mcpConfig);

  const stripped = stripManagedTomlBlocks(existing);
  const rootBlock = codexRootConfigToml(stripped);
  const skipMcpNames = existingMcpTableNames(stripped);
  const mcpBlock = buildCodexMcpConfigToml(mcpConfig, skipMcpNames);
  return [
    rootBlock,
    "",
    stripped,
    "",
    mcpBlock,
    "",
  ].filter((part) => part.trim().length > 0).join("\n").replace(/\n{3,}/g, "\n\n");
}

function writeCodexConfigToml(path: string, root: string, mcpConfig?: Record<string, any>): void {
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const next = existing.trim() ? mergeCodexConfigToml(existing, root, mcpConfig) : buildCodexConfigToml(root, mcpConfig);
  writeFileSync(path, next);
}

function openCodeMcpServer(server: any): Record<string, any> {
  if (server.url) {
    const headers = { ...(server.http_headers || {}) };
    if (server.bearer_token_env_var && process.env[server.bearer_token_env_var]) {
      headers.Authorization = `Bearer ${process.env[server.bearer_token_env_var]}`;
    }
    return {
      type: "remote",
      url: server.url,
      enabled: server.enabled !== false,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(server.tool_timeout_sec ? { timeout: Number(server.tool_timeout_sec) * 1000 } : {}),
    };
  }

  return {
    type: "local",
    command: [server.command, ...(Array.isArray(server.args) ? server.args : [])].filter(Boolean),
    enabled: server.enabled !== false,
    ...(server.env && typeof server.env === "object" ? { environment: server.env } : {}),
  };
}

function buildOpenCodeConfig(root: string, id: FrameworkId, mcpConfig?: Record<string, any>): Record<string, any> {
  const config: Record<string, any> = {
    "$schema": "https://opencode.ai/config.json",
    instructions: ["AGENTS.md"],
  };

  const servers = mcpConfig?.mcpServers || {};
  const mcp: Record<string, any> = {};
  for (const [rawName, server] of Object.entries(servers) as Array<[string, any]>) {
    if (!server?.command && !server?.url) continue;
    mcp[safeMcpName(rawName)] = openCodeMcpServer(server);
  }
  if (Object.keys(mcp).length > 0) config.mcp = mcp;
  return config;
}

function readOpenCodeConfig(path: string): Record<string, any> {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeOpenCodeConfig(path: string, generated: Record<string, any>) {
  writeFileSync(path, JSON.stringify(mergeOpenCodeConfigJson(readOpenCodeConfig(path), generated), null, 2));
}

function readActiveMcpConfig(root: string): Record<string, any> | null {
  const path = activeMcpPath(root);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function writeFrameworkFiles(id: FrameworkId, root: string) {
  const settings = readSettings();
  const mcpConfig = readActiveMcpConfig(root) || readActiveMcpConfig(CURRENT_INSTALL_ROOT) || undefined;
  settings.pai = { ...(settings.pai || {}), framework: id };
  settings.env = { ...(settings.env || {}), ...frameworkEnv(root, id) };
  writeFileSync(join(root, "settings.json"), JSON.stringify(settings, null, 2));

  const claudeMd = join(CURRENT_INSTALL_ROOT, "CLAUDE.md");
  if (existsSync(claudeMd)) {
    const content = frameworkInstructionContent(readFileSync(claudeMd, "utf-8"), id);
    if (id === "claude") {
      writeFileSync(join(root, "CLAUDE.md"), content);
    } else {
      writeFileSync(join(root, "AGENTS.md"), content.replace(/^#\s*CLAUDE\.md\b.*$/m, "# AGENTS.md"));
    }
  }

  if (id === "codex") {
    writeCodexConfigToml(join(root, "config.toml"), root, mcpConfig);
    writeFileSync(join(root, "hooks.json"), JSON.stringify(generateCodexHooks(root), null, 2));
  } else if (id === "opencode") {
    writeOpenCodeConfig(join(root, "opencode.json"), buildOpenCodeConfig(root, id, mcpConfig));
  }
}

function ensureFrameworkInstall(id: FrameworkId): string {
  const root = frameworkRoot(id);
  mkdirSync(root, { recursive: true });
  mkdirSync(DATA_DIR, { recursive: true });
  copyMissing(join(CURRENT_PAI_DIR, "MEMORY"), join(DATA_DIR, "MEMORY"));
  copyMissing(join(CURRENT_PAI_DIR, "USER"), join(DATA_DIR, "USER"));

  const targetPaiDir = join(root, "PAI");
  if (!existsSync(targetPaiDir)) {
    mkdirSync(targetPaiDir, { recursive: true });
  }

  for (const entry of readdirSync(CURRENT_PAI_DIR, { withFileTypes: true })) {
    if (entry.name === "MEMORY" || entry.name === "USER") continue;
    const src = join(CURRENT_PAI_DIR, entry.name);
    const dst = join(targetPaiDir, entry.name);
    syncManagedPaiEntry(src, dst);
  }

  for (const dir of ["skills", "hooks", "plugins", "commands", "agents", "MCPs"]) {
    if ((id === "codex" || id === "opencode") && dir === "agents") continue;
    if (id === "opencode" && dir === "commands") continue;
    const src = join(CURRENT_INSTALL_ROOT, dir);
    const dst = join(root, dir);
    syncManagedFrameworkDirectory(src, dst);
  }

  linkDirectory(join(root, "MEMORY"), join(DATA_DIR, "MEMORY"));
  linkDirectory(join(root, "USER"), join(DATA_DIR, "USER"));
  linkDirectory(join(root, "PAI", "MEMORY"), join(DATA_DIR, "MEMORY"));
  linkDirectory(join(root, "PAI", "USER"), join(DATA_DIR, "USER"));

  if (id === "codex") {
    syncCodexPrompts(root);
    syncCodexAgents(root);
  } else if (id === "opencode") {
    syncOpenCodeAgents(root);
    syncOpenCodeCommands(root);
  }

  writeFrameworkFiles(id, root);
  return root;
}

function setActiveFramework(id: FrameworkId) {
  const previousState = readFrameworkState();
  const root = ensureFrameworkInstall(id);
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(FRAMEWORK_STATE, JSON.stringify({
    active: id,
    frameworkName: frameworkName(id),
    root,
    dataDir: DATA_DIR,
    updatedAt: new Date().toISOString(),
  }, null, 2));
  writeFrameworkSwitchAudit(id, root, previousState);
  if (process.platform === "win32") {
    if (setWindowsPaiUserEnvironment(root, id)) {
      log("Windows user environment updated for direct PAI/provider launches.", "✅");
    } else {
      log("Could not update Windows user environment; current shell launch still works.", "⚠️");
    }
  }
  log(`Active framework set to ${frameworkName(id)} at ${root}`, "✅");
  log(`Global PAI memory remains at ${join(DATA_DIR, "MEMORY")}`, "🧠");
}

function writeFrameworkSwitchAudit(id: FrameworkId, root: string, previousState: any) {
  try {
    const auditDir = join(DATA_DIR, "MEMORY", "OBSERVABILITY");
    mkdirSync(auditDir, { recursive: true });
    appendFileSync(join(auditDir, "framework-switches.jsonl"), JSON.stringify({
      timestamp: new Date().toISOString(),
      source: "pai framework switch",
      active: id,
      root,
      dataDir: DATA_DIR,
      previousActive: previousState?.active || previousState?.framework || null,
      previousRoot: previousState?.root || null,
      cwd: process.cwd(),
      argv: process.argv,
      pid: process.pid,
      ppid: process.ppid,
    }) + "\n");
  } catch {
    // State switching must not fail because telemetry could not be recorded.
  }
}

function notifyVoice(message: string) {
  // Fire and forget voice notification using Qwen3-TTS with personality
  const identity = getIdentity();
  const personality = identity.personality;

  if (!personality?.baseVoice) {
    // Fall back to simple notify if no personality configured
    fetch("http://localhost:31337/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, play: true }),
    }).catch(() => {});
    return;
  }

  fetch(VOICE_SERVER, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      personality: {
        name: identity.name.toLowerCase(),
        base_voice: personality.baseVoice,
        enthusiasm: personality.enthusiasm,
        energy: personality.energy,
        expressiveness: personality.expressiveness,
        resilience: personality.resilience,
        composure: personality.composure,
        optimism: personality.optimism,
        warmth: personality.warmth,
        formality: personality.formality,
        directness: personality.directness,
        precision: personality.precision,
        curiosity: personality.curiosity,
        playfulness: personality.playfulness,
      },
    }),
  }).catch(() => {}); // Silently ignore errors
}

function displayBanner() {
  if (existsSync(BANNER_SCRIPT)) {
    spawnSync([process.execPath, BANNER_SCRIPT], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  }
}

function getCurrentVersion(framework = getActiveFramework()): string | null {
  if (process.platform === "win32") {
    const packageVersion = getGlobalCliPackageVersion(frameworkCliPackage(framework));
    if (packageVersion) return packageVersion;
  }

  const root = frameworkRoot(framework);
  const result = spawnSync(frameworkSpawnArgs([frameworkCommand(framework), "--version"]), {
    env: {
      ...process.env,
      ...frameworkEnv(root, framework),
    },
  });
  const output = `${result.stdout?.toString() || ""}\n${result.stderr?.toString() || ""}`;
  const match = output.match(/([0-9]+\.[0-9]+\.[0-9]+)/);
  return match ? match[1] : null;
}

function compareVersions(a: string, b: string): number {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (partsA[i] > partsB[i]) return 1;
    if (partsA[i] < partsB[i]) return -1;
  }
  return 0;
}

async function getLatestVersion(framework: FrameworkId): Promise<string | null> {
  if (framework !== "claude") return null;

  try {
    const response = await fetch(
      "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/latest"
    );
    const version = (await response.text()).trim();
    if (/^[0-9]+\.[0-9]+\.[0-9]+/.test(version)) {
      return version;
    }
  } catch {
    return null;
  }
  return null;
}

// ============================================================================
// MCP Management
// ============================================================================

function getMcpProfiles(): string[] {
  const MCP_DIR = getMcpDir();
  if (!existsSync(MCP_DIR)) return [];
  return readdirSync(MCP_DIR)
    .filter((f) => f.endsWith(".mcp.json"))
    .map((f) => f.replace(".mcp.json", ""));
}

function getIndividualMcps(): string[] {
  const MCP_DIR = getMcpDir();
  if (!existsSync(MCP_DIR)) return [];
  return readdirSync(MCP_DIR)
    .filter((f) => f.endsWith("-MCP.json"))
    .map((f) => f.replace("-MCP.json", ""));
}

function getCurrentProfile(): string | null {
  const activeFramework = getActiveFramework();
  const ACTIVE_MCP = activeMcpPath(frameworkRoot(activeFramework));
  if (!existsSync(ACTIVE_MCP)) return null;
  try {
    const stats = lstatSync(ACTIVE_MCP);
    if (stats.isSymbolicLink()) {
      const target = readFileSync(ACTIVE_MCP, "utf-8");
      // For symlink, we need the real target name
      const realpath = Bun.spawnSync(["readlink", ACTIVE_MCP]).stdout.toString().trim();
      return basename(realpath).replace(".mcp.json", "");
    }
    return "custom";
  } catch {
    return null;
  }
}

function mergeMcpConfigs(mcpFiles: string[]): object {
  const MCP_DIR = getMcpDir();
  const merged: Record<string, any> = { mcpServers: {} };

  for (const file of mcpFiles) {
    const filepath = join(MCP_DIR, file);
    if (!existsSync(filepath)) {
      log(`Warning: MCP file not found: ${file}`, "⚠️");
      continue;
    }
    try {
      const config = JSON.parse(readFileSync(filepath, "utf-8"));
      if (config.mcpServers) {
        Object.assign(merged.mcpServers, config.mcpServers);
      }
    } catch (e) {
      log(`Warning: Failed to parse ${file}`, "⚠️");
    }
  }

  return merged;
}

function writeActiveMcpConfig(config: Record<string, any>, activeFramework = getActiveFramework(), activeRoot = frameworkRoot(activeFramework)) {
  mkdirSync(activeRoot, { recursive: true });
  writeFileSync(activeMcpPath(activeRoot), JSON.stringify(config, null, 2));

  if (activeFramework === "codex") {
    writeCodexConfigToml(join(activeRoot, "config.toml"), activeRoot, config);
  } else if (activeFramework === "opencode") {
    writeOpenCodeConfig(join(activeRoot, "opencode.json"), buildOpenCodeConfig(activeRoot, activeFramework, config));
  }
}

function setMcpProfile(profile: string) {
  const MCP_DIR = getMcpDir();
  const activeFramework = getActiveFramework();
  const activeRoot = ensureFrameworkInstall(activeFramework);
  if (profile.toLowerCase() === "none") {
    writeActiveMcpConfig({ mcpServers: {} }, activeFramework, activeRoot);
    log(`Switched ${frameworkName(activeFramework)} to no MCP servers`, "✅");
    log(`Restart ${frameworkName(activeFramework)} to apply`, "⚠️");
    return;
  }
  const profileFile = join(MCP_DIR, `${profile}.mcp.json`);
  if (!existsSync(profileFile)) {
    error(`Profile '${profile}' not found`);
  }
  const config = JSON.parse(readFileSync(profileFile, "utf-8"));
  writeActiveMcpConfig(config, activeFramework, activeRoot);
  log(`Switched ${frameworkName(activeFramework)} to '${profile}' MCP profile`, "✅");
  log(`Restart ${frameworkName(activeFramework)} to apply`, "⚠️");
}

function setMcpCustom(mcpNames: string[]) {
  const MCP_DIR = getMcpDir();
  const files: string[] = [];

  for (const name of mcpNames) {
    if (name.toLowerCase() === "none") continue;
    const file = MCP_SHORTCUTS[name.toLowerCase()];
    if (file) {
      files.push(file);
    } else {
      // Try direct file match
      const directFile = `${name}-MCP.json`;
      const profileFile = `${name}.mcp.json`;
      if (existsSync(join(MCP_DIR, directFile))) {
        files.push(directFile);
      } else if (existsSync(join(MCP_DIR, profileFile))) {
        files.push(profileFile);
      } else {
        error(`Unknown MCP: ${name}`);
      }
    }
  }

  const activeFramework = getActiveFramework();
  const activeRoot = ensureFrameworkInstall(activeFramework);
  const ACTIVE_MCP = activeMcpPath(activeRoot);
  const merged = mergeMcpConfigs(files) as Record<string, any>;

  // Remove symlink if exists, write new file
  if (existsSync(ACTIVE_MCP)) {
    unlinkSync(ACTIVE_MCP);
  }
  writeActiveMcpConfig(merged, activeFramework, activeRoot);

  const serverCount = Object.keys((merged as any).mcpServers || {}).length;
  if (serverCount > 0) {
    log(`Configured ${serverCount} MCP server(s) for ${frameworkName(activeFramework)}: ${mcpNames.join(", ")}`, "✅");
  }
}

// ============================================================================
// Wallpaper Management
// ============================================================================

function getWallpapers(): string[] {
  if (!existsSync(WALLPAPER_DIR)) return [];
  return readdirSync(WALLPAPER_DIR)
    .filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f))
    .sort();
}

function getWallpaperName(filename: string): string {
  return basename(filename).replace(/\.(png|jpg|jpeg|webp)$/i, "");
}

function findWallpaper(query: string): string | null {
  const wallpapers = getWallpapers();
  const queryLower = query.toLowerCase();

  // Exact match (without extension)
  const exact = wallpapers.find((w) => getWallpaperName(w).toLowerCase() === queryLower);
  if (exact) return exact;

  // Partial match
  const partial = wallpapers.find((w) => getWallpaperName(w).toLowerCase().includes(queryLower));
  if (partial) return partial;

  // Fuzzy: any word match
  const words = queryLower.split(/[-_\s]+/);
  const fuzzy = wallpapers.find((w) => {
    const name = getWallpaperName(w).toLowerCase();
    return words.some((word) => name.includes(word));
  });
  return fuzzy || null;
}

function setWallpaper(filename: string): boolean {
  const fullPath = join(WALLPAPER_DIR, filename);
  if (!existsSync(fullPath)) {
    log(`Wallpaper not found: ${fullPath}`, "❌");
    return false;
  }

  let success = true;

  // Set Kitty background
  try {
    const kittyResult = spawnSync(["kitty", "@", "set-background-image", fullPath]);
    if (kittyResult.exitCode === 0) {
      log("Kitty background set", "✅");
    } else {
      log("Failed to set Kitty background", "⚠️");
      success = false;
    }
  } catch {
    log("Kitty not available", "⚠️");
  }

  // Set macOS desktop background
  try {
    const script = `tell application "System Events" to tell every desktop to set picture to "${fullPath}"`;
    const macResult = spawnSync(["osascript", "-e", script]);
    if (macResult.exitCode === 0) {
      log("macOS desktop set", "✅");
    } else {
      log("Failed to set macOS desktop", "⚠️");
      success = false;
    }
  } catch {
    log("Could not set macOS desktop", "⚠️");
  }

  return success;
}

function cmdWallpaper(args: string[]) {
  const wallpapers = getWallpapers();

  if (wallpapers.length === 0) {
    error(`No wallpapers found in ${WALLPAPER_DIR}`);
  }

  // No args or --list: show available wallpapers
  if (args.length === 0 || args[0] === "--list" || args[0] === "-l" || args[0] === "list") {
    log("Available wallpapers:", "🖼️");
    console.log();
    wallpapers.forEach((w, i) => {
      console.log(`  ${i + 1}. ${getWallpaperName(w)}`);
    });
    console.log();
    log("Usage: k -w <name>", "💡");
    log("Example: k -w circuit-board", "💡");
    return;
  }

  // Find and set the wallpaper
  const query = args.join(" ");
  const match = findWallpaper(query);

  if (!match) {
    log(`No wallpaper matching "${query}"`, "❌");
    console.log("\nAvailable wallpapers:");
    wallpapers.forEach((w) => console.log(`  - ${getWallpaperName(w)}`));
    process.exit(1);
  }

  const name = getWallpaperName(match);
  log(`Switching to: ${name}`, "🖼️");

  const success = setWallpaper(match);
  if (success) {
    log(`Wallpaper set to ${name}`, "✅");
    notifyVoice(`Wallpaper changed to ${name}`);
  } else {
    error("Failed to set wallpaper");
  }
}


// ============================================================================
// Commands
// ============================================================================

async function cmdLaunch(options: { mcp?: string; resume?: boolean; dangerous?: boolean; local?: boolean; systemPrompt?: string }) {
  // CLAUDE.md is now static — no build step needed.
  // Algorithm spec is loaded on-demand when Algorithm mode triggers.
  // (InstantiatePAI.ts is retired — kept for reference only)

  displayBanner();
  const activeFramework = getActiveFramework();
  const activeRoot = ensureFrameworkInstall(activeFramework);
  const args = [frameworkCommand(activeFramework)];

  // PAI System Prompt — currently Claude Code-specific. Codex/OpenCode use
  // AGENTS.md generated by the framework switch/install path.
  const systemPromptFile = options.systemPrompt ?? join(activeRoot, "PAI", "PAI_SYSTEM_PROMPT.md");
  if (activeFramework === "claude" && existsSync(systemPromptFile)) {
    args.push("--append-system-prompt-file", systemPromptFile);
  } else if (activeFramework !== "claude" && options.systemPrompt) {
    log(`System prompt append is Claude-only; ${frameworkName(activeFramework)} will use its generated AGENTS.md instructions.`, "⚠️");
  }

  // Handle MCP configuration. PAI profile files use Claude's mcpServers shape;
  // setMcpCustom projects that shape into the active framework's native config.
  if (options.mcp) {
    const mcpNames = options.mcp.split(",").map((s) => s.trim());
    setMcpCustom(mcpNames);
  }

  // Add framework-native flags.
  if (options.resume) {
    if (activeFramework === "claude") {
      args.push("--resume");
    } else if (activeFramework === "codex") {
      args.push("resume", "--last");
    } else {
      args.push("--continue");
    }
  }

  if (options.dangerous) {
    if (activeFramework === "claude" || activeFramework === "opencode") {
      args.push("--dangerously-skip-permissions");
    } else {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    }
  }

  // Keep the framework session in the caller's current directory. The active
  // framework home is supplied through env, so PAI config still resolves there.

  // Voice notification (using focused marker for calmer tone).
  // Reads daidentity.startupCatchphrase from settings.json so the user's
  // install-time catchphrase is actually honored. Falls back to the
  // historical "<name> here, ready to go." default when unset.
  notifyVoice(`[🎯 focused] ${getStartupCatchphrase()}`);

  // Launch the active framework CLI.
  // BILLING: subscription, not API. Strip ANTHROPIC_API_KEY before spawn so the
  // interactive session uses OAuth (`claude /login`) instead of API-key billing.
  // Mirrors the protection in cmdPrompt() — same hazard, same fix.
  const launchEnv = { ...process.env };
  Object.assign(launchEnv, frameworkEnv(activeRoot, activeFramework));
  delete launchEnv.ANTHROPIC_API_KEY;
  const launchArgs = frameworkSpawnArgs(args);
  log(`Launching ${frameworkName(activeFramework)} from ${activeRoot}`, "🚀");
  const started = Date.now();
  let proc;
  try {
    proc = spawn(launchArgs, {
      stdio: ["inherit", "inherit", "inherit"],
      env: launchEnv,
    });
  } catch (err) {
    error(`Failed to launch ${frameworkName(activeFramework)} with command '${launchArgs.join(" ")}': ${err instanceof Error ? err.message : String(err)}`);
  }

  // Wait for the active framework CLI to exit.
  const exitCode = await proc.exited;
  const elapsedMs = Date.now() - started;
  if (elapsedMs < 1500) {
    log(`${frameworkName(activeFramework)} exited immediately with code ${exitCode}. Run 'pai framework status' to confirm the active framework.`, "⚠️");
  }
  if (exitCode !== 0) process.exit(exitCode);
}

async function cmdUpdate() {
  log("Checking for updates...", "🔍");

  const activeFramework = getActiveFramework();
  const current = getCurrentVersion();
  const latest = await getLatestVersion(activeFramework);

  if (!current) {
    error("Could not detect current version");
  }

  console.log(`Current: v${current}`);
  if (latest) {
    console.log(`Latest:  v${latest}`);
  }

  // Skip if already up to date
  if (latest && compareVersions(current, latest) >= 0) {
    log("Already up to date", "✅");
    return;
  }

  log(`Updating ${frameworkName(activeFramework)}...`, "🔄");

  // Step 1: Update Bun
  log("Step 1/2: Updating Bun...", "📦");
  const bunResult = process.platform === "win32"
    ? spawnSync([process.execPath, "upgrade"], { stdin: "inherit", stdout: "inherit", stderr: "inherit" })
    : spawnSync(["brew", "upgrade", "bun"]);
  if (bunResult.exitCode !== 0) {
    log("Bun update skipped (may already be latest)", "⚠️");
  } else {
    log("Bun updated", "✅");
  }

  // Step 2: Update selected framework CLI
  log(`Step 2/2: Installing latest ${frameworkName(activeFramework)}...`, "🤖");
  const frameworkResult = process.platform === "win32"
    ? spawnSync([process.execPath, "install", "-g", frameworkCliPackage(activeFramework)], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      })
    : spawnSync(["bash", "-c", activeFramework === "codex"
      ? "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh"
      : activeFramework === "opencode"
        ? "curl -fsSL https://opencode.ai/install | bash"
        : "curl -fsSL https://claude.ai/install.sh | bash"]);
  if (frameworkResult.exitCode !== 0) {
    error(`${frameworkName(activeFramework)} installation failed`);
  }
  log(`${frameworkName(activeFramework)} updated`, "✅");

  // Show final version
  const newVersion = getCurrentVersion();
  if (newVersion) {
    console.log(`Now running: v${newVersion}`);
  }
}

async function cmdVersion() {
  log("Checking versions...", "🔍");

  const activeFramework = getActiveFramework();
  const current = getCurrentVersion();
  const latest = await getLatestVersion(activeFramework);

  if (!current) {
    error("Could not detect current version");
  }

  console.log(`Current: v${current}`);
  if (latest) {
    console.log(`Latest:  v${latest}`);
    const cmp = compareVersions(current, latest);
    if (cmp >= 0) {
      log("Up to date", "✅");
    } else {
      log("Update available (run 'k update')", "⚠️");
    }
  } else {
    log(`Latest-version lookup is not mapped for ${frameworkName(activeFramework)} yet`, "⚠️");
  }
}

function cmdProfiles() {
  log("Available MCP Profiles:", "📋");
  console.log();

  const current = getCurrentProfile();
  const profiles = getMcpProfiles();

  for (const profile of profiles) {
    const isCurrent = profile === current;
    const desc = PROFILE_DESCRIPTIONS[profile] || "";
    const marker = isCurrent ? "→ " : "  ";
    const badge = isCurrent ? " (active)" : "";
    console.log(`${marker}${profile}${badge}`);
    if (desc) console.log(`    ${desc}`);
  }

  console.log();
  log("Usage: k mcp set <profile>", "💡");
}

function cmdMcpList() {
  log("Available MCPs:", "📋");
  console.log();

  // Individual MCPs
  log("Individual MCPs (use with -m):", "📦");
  const mcps = getIndividualMcps();
  for (const mcp of mcps) {
    const shortcut = Object.entries(MCP_SHORTCUTS)
      .filter(([_, v]) => v === `${mcp}-MCP.json`)
      .map(([k]) => k);
    const shortcuts = shortcut.length > 0 ? ` (${shortcut.join(", ")})` : "";
    console.log(`  ${mcp}${shortcuts}`);
  }

  console.log();
  log("Profiles (use with 'k mcp set'):", "📁");
  const profiles = getMcpProfiles();
  for (const profile of profiles) {
    const desc = PROFILE_DESCRIPTIONS[profile] || "";
    console.log(`  ${profile}${desc ? ` - ${desc}` : ""}`);
  }

  console.log();
  log("Examples:", "💡");
  console.log("  k -m bd          # Bright Data only");
  console.log("  k -m bd,ap       # Bright Data + Apify");
  console.log("  k mcp set research  # Full research profile");
}

function cmdFramework(subCommand?: string, subArg?: string) {
  if (!subCommand || subCommand === "status") {
    const active = getActiveFramework();
    console.log(`Active framework: ${frameworkName(active)} (${active})`);
    console.log(`Framework root: ${frameworkRoot(active)}`);
    console.log(`Global data: ${DATA_DIR}`);
    console.log("");
    console.log("Available frameworks:");
    console.log("  claude    Claude Code");
    console.log("  codex     Codex");
    console.log("  opencode  OpenCode");
    return;
  }

  if (subCommand === "switch" || subCommand === "set") {
    const target = normalizeFramework(subArg);
    if (!target) error("Usage: k framework switch claude|codex|opencode");
    setActiveFramework(target);
    return;
  }

  error("Usage: k framework status | k framework switch claude|codex|opencode");
}

function cmdMemory(args: string[]) {
  const subCommand = args[0];
  if (subCommand !== "delete" && subCommand !== "redact") {
    error("Usage: k memory delete --path <MEMORY path> --patterns-file <file> | k memory redact --text <literal>");
  }

  const tool = join(CURRENT_PAI_DIR, "TOOLS", "MemoryDelete.ts");
  const result = spawnSync([process.execPath, tool, ...args.slice(1)], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      PAI_DIR: CURRENT_PAI_DIR,
      PAI_DATA_DIR: DATA_DIR,
      PAI_FRAMEWORK: getActiveFramework(),
      PAI_FRAMEWORK_DIR: frameworkRoot(getActiveFramework()),
    },
  });
  process.exit(result.exitCode ?? 1);
}

function cmdDoctor() {
  const activeFramework = getActiveFramework();
  const activeRoot = frameworkRoot(activeFramework);
  const tool = join(CURRENT_PAI_DIR, "TOOLS", "PaiDoctor.ts");
  const result = spawnSync([process.execPath, tool], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      PAI_DIR: CURRENT_PAI_DIR,
      PAI_DATA_DIR: DATA_DIR,
      PAI_FRAMEWORK: activeFramework,
      PAI_FRAMEWORK_DIR: activeRoot,
      PAI_SETTINGS_PATH: join(activeRoot, "settings.json"),
      PAI_CONFIG_DIR: CONFIG_DIR,
    },
  });
  process.exit(result.exitCode ?? 1);
}

async function cmdPrompt(prompt: string) {
  // One-shot prompt execution
  // NOTE: No --dangerously-skip-permissions - rely on settings.json permissions
  // BILLING: subscription/session auth, not API. Strip API credentials from inherited env.
  const activeFramework = getActiveFramework();
  const activeRoot = ensureFrameworkInstall(activeFramework);
  const args = activeFramework === "codex"
    ? [frameworkCommand(activeFramework), "exec", "--sandbox", "workspace-write", "--skip-git-repo-check", "--cd", process.cwd(), "-"]
    : activeFramework === "opencode"
      ? [frameworkCommand(activeFramework), "run", "-"]
      : [frameworkCommand(activeFramework), "-p", prompt];

  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  Object.assign(env, frameworkEnv(activeRoot, activeFramework));
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  const proc = spawn(frameworkSpawnArgs(args), {
    stdin: activeFramework === "codex" || activeFramework === "opencode" ? new Blob([prompt]) : "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env,
  });

  const exitCode = await proc.exited;
  process.exit(exitCode);
}

function cmdHelp() {
  console.log(`
pai - Personal AI CLI Tool (v2.0.0)

USAGE:
  k                        Launch active framework (Claude/Codex/OpenCode)
  k -m <mcp>               Launch with specific MCP(s)
  k -m bd,ap               Launch with multiple MCPs
  k -r, --resume           Resume last session
  k -d, --dangerous        Use the active CLI's permission-bypass flag
  k -s, --system-prompt    Claude-only system prompt file to append
  k -l, --local            Compatibility flag; current directory is already preserved

COMMANDS:
  k update                 Update active framework CLI
  k version, -v            Show version information
  k framework status       Show active framework and global memory path
  k framework switch codex Switch framework (claude|codex|opencode)
  k memory delete          Delete a memory file and redact cache/log copies
  k memory redact          Redact exact literals from PAI cache/log files
  k doctor                 Run PAI runtime diagnostics (config, hooks, Pulse, MCPs)
  k profiles               List available MCP profiles
  k mcp list               List all available MCPs
  k mcp set <profile>      Set MCP profile permanently
  k prompt "<text>"        One-shot prompt execution
  k -w, --wallpaper        List/switch wallpapers (Kitty + macOS)
  k help, -h               Show this help

TROUBLESHOOTING:
  If startup reports a PAI self-check warning, run:
    k doctor

  Optional credential reminders are warnings, not failures. Critical failures
  point at the config, hook, Pulse, or install surface that needs repair.

MCP SHORTCUTS:
  bd, brightdata           Bright Data scraping
  ap, apify                Apify automation
  cu, clickup              Official ClickUp (tasks, time tracking, docs)
  dev                      Development tools
  sec, security            Reserved security profile
  research                 Research tools (BD + Apify)
  full                     All MCPs
  min, minimal             Base PAI tools only
  none                     No MCPs

EXAMPLES:
  k                        Start with current profile
  k -m bd                  Start with Bright Data
  k -m bd,ap               Start with multiple MCPs
  k -r                     Resume last session
  k -d                     Start with native permission bypass enabled
  k mcp set research       Switch to research profile
  k framework switch codex Switch to Codex while keeping ~/.pai/MEMORY
  k memory delete --path MEMORY/RELATIONSHIP/note.md --patterns-file /tmp/patterns.txt
  k doctor                 Run full local PAI runtime diagnostics
  k update                 Update active framework CLI
  k prompt "What time is it?"   One-shot prompt
  k -w                     List available wallpapers
  k -w circuit-board       Switch wallpaper (Kitty + macOS)
`);
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const args = process.argv.slice(2);

  // No args - launch without touching MCP config (use native /mcp commands)
  if (args.length === 0) {
    await cmdLaunch({});
    return;
  }

  // Parse arguments
  let mcp: string | undefined;
  let resume = false;
  let dangerous = false;
  let local = false;
  let systemPrompt: string | undefined;
  let command: string | undefined;
  let subCommand: string | undefined;
  let subArg: string | undefined;
  let promptText: string | undefined;
  let wallpaperArgs: string[] = [];
  let passthroughArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case "-m":
      case "--mcp":
        const nextArg = args[i + 1];
        // -m with no arg, or -m 0, or -m "" means no MCPs
        if (!nextArg || nextArg.startsWith("-") || nextArg === "0" || nextArg === "") {
          mcp = "none";
          if (nextArg === "0" || nextArg === "") i++;
        } else {
          mcp = args[++i];
        }
        break;
      case "-r":
      case "--resume":
        resume = true;
        break;
      case "-d":
      case "--dangerous":
        dangerous = true;
        break;
      case "-s":
      case "--system-prompt":
        systemPrompt = args[++i];
        break;
      case "-l":
      case "--local":
        local = true;
        break;
      case "-v":
      case "--version":
      case "version":
        command = "version";
        break;
      case "-h":
      case "--help":
      case "help":
        command = "help";
        break;
      case "update":
        command = "update";
        break;
      case "profiles":
        command = "profiles";
        break;
      case "framework":
      case "fw":
        command = "framework";
        subCommand = args[++i];
        subArg = args[++i];
        break;
      case "mcp":
        command = "mcp";
        subCommand = args[++i];
        subArg = args[++i];
        break;
      case "memory":
        command = "memory";
        passthroughArgs = args.slice(i + 1);
        i = args.length; // Exit loop
        break;
      case "doctor":
        command = "doctor";
        break;
      case "prompt":
      case "-p":
        command = "prompt";
        promptText = args.slice(i + 1).join(" ");
        i = args.length; // Exit loop
        break;
      case "-w":
      case "--wallpaper":
        command = "wallpaper";
        wallpaperArgs = args.slice(i + 1);
        i = args.length; // Exit loop
        break;
      default:
        if (!arg.startsWith("-")) {
          // Might be an unknown command
          error(`Unknown command: ${arg}. Use 'k help' for usage.`);
        }
    }
  }

  // Handle commands
  switch (command) {
    case "version":
      await cmdVersion();
      break;
    case "help":
      cmdHelp();
      break;
    case "update":
      await cmdUpdate();
      break;
    case "profiles":
      cmdProfiles();
      break;
    case "framework":
      cmdFramework(subCommand, subArg);
      break;
    case "mcp":
      if (subCommand === "list") {
        cmdMcpList();
      } else if (subCommand === "set" && subArg) {
        setMcpProfile(subArg);
      } else {
        error("Usage: k mcp list | k mcp set <profile>");
      }
      break;
    case "memory":
      cmdMemory(passthroughArgs);
      break;
    case "doctor":
      cmdDoctor();
      break;
    case "prompt":
      if (!promptText) {
        error("Usage: k prompt \"your prompt here\"");
      }
      await cmdPrompt(promptText);
      break;
    case "wallpaper":
      cmdWallpaper(wallpaperArgs);
      break;
    default:
      // Launch with options
      await cmdLaunch({ mcp, resume, dangerous, local, systemPrompt });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
