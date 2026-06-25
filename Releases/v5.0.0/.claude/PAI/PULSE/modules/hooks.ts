/**
 * Pulse Module: Hook Validation Server
 *
 * Extracted from pulse.ts inline code.
 * Validates skill and agent tool calls via HTTP hooks.
 */

import { basename, join } from "path"
import { existsSync, readFileSync } from "fs"
import { getFrameworkDir } from "../../TOOLS/lib/paths"

// ── Types ──

export interface HooksConfig {
  enabled: boolean
  blocked_skills?: string[]
}

interface HookStats {
  requests: number
  skillGuard: { total: number; blocked: number; passed: number }
  agentGuard: { total: number; warned: number; passed: number }
}

interface RegisteredHook {
  event: string
  matcher: string
  command: string
  target: string | null
  status: "active" | "missing" | "unknown"
}

// ── State ──

const stats: HookStats = {
  requests: 0,
  skillGuard: { total: 0, blocked: 0, passed: 0 },
  agentGuard: { total: 0, warned: 0, passed: 0 },
}

let blockedSkills = ["keybindings-help"]
const FAST_AGENT_TYPES = ["Explore"]
const FAST_MODELS = ["haiku"]

// ── Init ──

export function startHooks(config: HooksConfig): void {
  if (config.blocked_skills) {
    blockedSkills = config.blocked_skills
  }
}

// ── Route Handler ──

export function handleHooksRequest(req: Request, pathname: string): Response | null {
  if (req.method !== "POST") return null

  try {
    // Synchronous parsing isn't possible with Request — return a promise-wrapping response
    return null // Handled by async version below
  } catch {
    return null
  }
}

export async function handleHooksRequestAsync(req: Request, pathname: string): Promise<Response | null> {
  if (req.method !== "POST") return null

  try {
    const body = await req.json()

    if (pathname === "/hooks/skill-guard") {
      return handleSkillGuard(body)
    }

    if (pathname === "/hooks/agent-guard") {
      return handleAgentGuard(body)
    }

    return null
  } catch {
    stats.requests++
    return new Response("", { status: 200 }) // Fail open
  }
}

// ── Skill Guard ──

function handleSkillGuard(body: { tool_input?: { skill?: string } }): Response {
  stats.requests++
  stats.skillGuard.total++
  const skillName = (body.tool_input?.skill || "").toLowerCase().trim()

  if (blockedSkills.includes(skillName)) {
    stats.skillGuard.blocked++
    return Response.json({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `BLOCKED: "${skillName}" is a known false-positive skill triggered by position bias. The user did NOT ask about keybindings. Continue with the ACTUAL task the user requested.`,
      },
    })
  }

  stats.skillGuard.passed++
  return new Response("", { status: 200 })
}

// ── Agent Guard ──

function handleAgentGuard(body: {
  tool_input?: { run_in_background?: boolean; subagent_type?: string; model?: string; prompt?: string; description?: string; name?: string }
}): Response {
  stats.requests++
  stats.agentGuard.total++
  const ti = body.tool_input || {}

  if (FAST_AGENT_TYPES.includes(ti.subagent_type || "") || FAST_MODELS.includes(ti.model || "")) {
    stats.agentGuard.passed++
    return new Response("", { status: 200 })
  }

  if (ti.run_in_background === true) {
    stats.agentGuard.passed++
    const name = ti.description || ti.name || ti.subagent_type || "unknown"
    return Response.json({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        additionalContext: `WATCHDOG: Background agent "${name}" launching. If not already running, start an agent watchdog Monitor:\nMonitor({ description: "Agent watchdog", persistent: true, timeout_ms: 3600000, command: "bun $PAI_DIR/TOOLS/AgentWatchdog.ts" })`,
      },
    })
  }

  if (/##\s*Scope[\s\S]*?Timing:\s*FAST/i.test(ti.prompt || "")) {
    stats.agentGuard.passed++
    return new Response("", { status: 200 })
  }

  stats.agentGuard.warned++
  return Response.json({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: "Foreground agent warning",
      additionalContext: `WARNING: Foreground agent "${ti.description || ti.subagent_type || "unknown"}" — consider run_in_background: true`,
    },
  })
}

// ── Health ──

function detectFramework(frameworkDir: string): "claude" | "codex" | "opencode" | "unknown" {
  if (existsSync(join(frameworkDir, "hooks.json")) && existsSync(join(frameworkDir, "config.toml"))) return "codex"
  if (existsSync(join(frameworkDir, "opencode.json"))) return "opencode"
  if (existsSync(join(frameworkDir, "settings.json"))) return "claude"
  return "unknown"
}

function hookTargetFromCommand(command: string): string | null {
  const targetMatch = command.match(/--target\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))/)
  if (targetMatch) return targetMatch[1] || targetMatch[2] || targetMatch[3]
  const hookMatch = command.match(/(?:^|\s)([^\s"']+\.hook\.(?:ts|js|mjs|cjs))(?:\s|$)/)
  return hookMatch ? hookMatch[1] : null
}

function resolveHookTarget(frameworkDir: string, target: string | null): string | null {
  if (!target) return null
  const normalized = target.replace(/\\/g, "/")
  if (/^[A-Za-z]:[\\/]/.test(target) || target.startsWith("/")) return target
  if (normalized.startsWith("hooks/")) return join(frameworkDir, target)
  return join(frameworkDir, "hooks", target)
}

function hookStatus(frameworkDir: string, command: string): { target: string | null; status: RegisteredHook["status"] } {
  const target = hookTargetFromCommand(command)
  if (!target) return { target, status: "unknown" }
  const targets = target.split(",").map((part) => part.trim()).filter(Boolean)
  const resolved = targets.map((part) => resolveHookTarget(frameworkDir, part)).filter((part): part is string => Boolean(part))
  if (resolved.length === 0) return { target, status: "unknown" }
  const missing = resolved.filter((path) => !existsSync(path))
  return {
    target: targets.map((part) => basename(part)).join(","),
    status: missing.length === 0 ? "active" : "missing",
  }
}

function collectHooksFromClaudeSettings(frameworkDir: string): { configPath: string; hooks: RegisteredHook[] } {
  const configPath = join(frameworkDir, "settings.json")
  const hooks: RegisteredHook[] = []
  if (!existsSync(configPath)) return { configPath, hooks }
  const settings = JSON.parse(readFileSync(configPath, "utf-8"))
  for (const [event, entries] of Object.entries(settings.hooks || {})) {
    if (!Array.isArray(entries)) continue
    for (const entry of entries as any[]) {
      const matcher = entry.matcher || "(all)"
      for (const hook of entry.hooks || []) {
        const command = String(hook.command || hook.url || "")
        if (!command) continue
        const status = hook.type === "command" ? hookStatus(frameworkDir, command) : { target: null, status: "active" as const }
        hooks.push({ event, matcher, command, target: status.target, status: status.status })
      }
    }
  }
  return { configPath, hooks }
}

function collectHooksFromCodexJson(frameworkDir: string): { configPath: string; hooks: RegisteredHook[] } {
  const configPath = join(frameworkDir, "hooks.json")
  const hooks: RegisteredHook[] = []
  if (!existsSync(configPath)) return { configPath, hooks }
  const config = JSON.parse(readFileSync(configPath, "utf-8"))
  for (const [event, entries] of Object.entries(config.hooks || {})) {
    if (!Array.isArray(entries)) continue
    for (const entry of entries as any[]) {
      const matcher = entry.matcher || "(all)"
      const hookList = Array.isArray(entry.hooks) ? entry.hooks : [entry]
      for (const hook of hookList) {
        const command = String(hook.commandWindows || hook.command || "")
        if (!command) continue
        const status = hookStatus(frameworkDir, command)
        hooks.push({ event, matcher, command, target: status.target, status: status.status })
      }
    }
  }
  return { configPath, hooks }
}

export function hooksHealth(): Record<string, unknown> {
  const frameworkDir = getFrameworkDir()
  const framework = detectFramework(frameworkDir)
  const registered = framework === "codex"
    ? collectHooksFromCodexJson(frameworkDir)
    : collectHooksFromClaudeSettings(frameworkDir)
  const missing = registered.hooks.filter((hook) => hook.status === "missing")
  return {
    status: missing.length > 0 ? "degraded" : "ok",
    framework,
    frameworkDir,
    configPath: registered.configPath,
    registeredHooks: registered.hooks.length,
    missingHooks: missing,
    hooks: registered.hooks,
    stats,
  }
}
