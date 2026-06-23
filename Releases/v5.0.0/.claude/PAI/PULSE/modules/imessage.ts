/**
 * PAI Pulse — iMessage Module
 *
 * Absorbed from standalone iMessageBot into Pulse module system.
 * Polls ~/Library/Messages/chat.db for incoming iMessages, processes them
 * through the active PAI inference backend and sends replies back via AppleScript.
 *
 * Architecture: SQLite poll -> auth -> active framework inference -> AppleScript reply
 *
 * Exports:
 *   startIMessage(config)  — starts SQLite polling loop (runs forever, supervised by parent)
 *   stopIMessage()         — stops polling
 *   imessageHealth()       — returns health status
 *
 * Does NOT create its own HTTP server — health is exposed via Pulse's hook server.
 */

import { ConversationStore } from "../lib/conversation"
import { sanitize, analyzeForInjection } from "../lib/sanitize"
import {
  getNewMessages,
  getLatestRowId,
  verifyAccess,
} from "../lib/messages-db"
import { sendMessage } from "../lib/imessage-send"
import { appendFile, mkdir, rename } from "fs/promises"
import { join } from "path"
import { memoryPath } from "../../TOOLS/lib/paths"
import { inference } from "../../TOOLS/Inference"

// BILLING: Strip Anthropic API credentials so framework inference cannot
// accidentally fall back to API-key billing in Claude compatibility mode.
delete process.env.ANTHROPIC_API_KEY
delete process.env.ANTHROPIC_AUTH_TOKEN

// ── Config Interface ──

export interface IMessageConfig {
  enabled: boolean
  allowed_handles?: string[]
  poll_interval_ms?: number
  max_turns?: number
  sdk_timeout_ms?: number
}

// ── Health Status ──

export interface IMessageHealth {
  status: "running" | "stopped" | "error"
  uptime_ms: number
  messages_received: number
  messages_responded: number
  processing: boolean
  last_row_id: number
  allowed_handles: string[]
  poll_interval_ms: number
  last_error?: string
}

// ── Module State ──

const STATE_DIR = memoryPath("STATE", "pulse", "imessage")
const LOGS_DIR = memoryPath("OBSERVABILITY", "pulse", "imessage")
const IMESSAGE_SYSTEM_PROMPT = `You are {{DA_NAME}}, responding via iMessage. {{PRINCIPAL_NAME}} is messaging you from his phone.

CRITICAL RULES FOR IMESSAGE MODE:
- Keep responses concise, under 200 words, and plain text.
- No markdown headers, Algorithm format, Native format, Minimal format, or voice notification curls.
- Speak naturally.
- When doing tasks, do them and confirm briefly what you did.
- You have access to PAI capabilities through the active framework.`

let pollTimer: ReturnType<typeof setInterval> | null = null
let running = false
let startedAt = 0
let messagesReceived = 0
let messagesResponded = 0
let lastRowId = 0
let processing = false
let lastError: string | undefined
let allowedHandles = new Set<string>()
let pollIntervalMs = 3000
let sdkTimeoutMs = 120_000
let conversationStore: ConversationStore | null = null
let cursorPath = ""
let chatLogPath = ""

// ── Logging ──

function log(level: "info" | "warn" | "error", msg: string, data?: unknown) {
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    mod: "imessage",
    msg,
    ...(data && typeof data === "object" ? data : data ? { data } : {}),
  })
  if (level === "error") {
    console.error(entry)
  } else {
    console.log(entry)
  }
}

// ── Cursor Persistence ──

async function saveCursor() {
  const tmp = cursorPath + ".tmp"
  await Bun.write(tmp, JSON.stringify({ lastRowId }, null, 2))
  await rename(tmp, cursorPath)
}

// ── Chat Log ──

async function appendChatLog(
  handle: string,
  userMsg: string,
  botMsg: string,
) {
  const ts = new Date().toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
  const entry = `\n### ${ts}\n**${handle}:** ${userMsg}\n\n**{{DA_NAME}}:** ${botMsg}\n\n---\n`
  await appendFile(chatLogPath, entry).catch(() => {})
}

// ── Process a Single Message ──

async function processMessage(
  text: string,
  handle: string,
): Promise<string> {
  const sanitized = sanitize(text)
  if (!sanitized) return ""

  const injection = analyzeForInjection(sanitized)
  if (injection.riskLevel === "CRITICAL") {
    log("warn", "Blocked CRITICAL injection attempt", {
      handle,
      patterns: injection.matchedPatterns,
    })
    return "Message blocked for security reasons."
  }

  // Build prompt with conversation history
  const history = conversationStore!.getHistory()
  let prompt = sanitized
  if (history.length > 0) {
    const historyText = history
      .slice(-10)
      .map((m) => `${m.role === "user" ? "Principal" : "DA"}: ${m.content}`)
      .join("\n")
    prompt = `Previous conversation:\n${historyText}\n\nPrincipal's new message: ${sanitized}`
  }

  const result = await inference({
    systemPrompt: IMESSAGE_SYSTEM_PROMPT,
    userPrompt: prompt,
    level: "standard",
    timeout: sdkTimeoutMs,
  })

  if (result.success) {
    log("info", "Framework inference complete", {
      latencyMs: result.latencyMs,
      level: result.level,
    })
    return result.output || "Sorry, I wasn't able to generate a response. Try again?"
  }

  log("error", "Framework inference failed", { error: result.error })
  return "Sorry, I wasn't able to generate a response. Try again?"
}

// ── Poll Loop ──

async function poll() {
  try {
    const messages = getNewMessages(lastRowId)

    for (const msg of messages) {
      // Update cursor regardless of auth
      lastRowId = msg.rowid

      // Auth check
      if (!allowedHandles.has(msg.handle)) {
        log("warn", "Rejected message from unauthorized handle", {
          handle: msg.handle,
        })
        continue
      }

      messagesReceived++
      log("info", "Message received", {
        handle: msg.handle,
        textLength: msg.text.length,
        rowid: msg.rowid,
      })

      // Sequential processing
      if (processing) {
        await sendMessage(
          msg.handle,
          "Still processing your previous message. Please wait.",
        )
        continue
      }

      processing = true
      const startTime = Date.now()

      try {
        const response = await processMessage(msg.text, msg.handle)
        const sent = await sendMessage(msg.handle, response)

        if (sent) {
          messagesResponded++
          log("info", "Response sent", {
            durationMs: Date.now() - startTime,
            responseLength: response.length,
          })

          await conversationStore!.addExchange(msg.text, response)
          await appendChatLog(msg.handle, msg.text, response)
        } else {
          log("error", "Failed to send iMessage reply", {
            handle: msg.handle,
          })
        }
      } catch (err) {
        lastError = String(err)
        log("error", "Message processing failed", { error: lastError })
        await sendMessage(
          msg.handle,
          "Something went wrong processing your message. Try again?",
        ).catch(() => {})
      } finally {
        processing = false
      }
    }

    // Persist cursor after processing batch
    await saveCursor()
  } catch (err) {
    lastError = String(err)
    log("error", "Poll cycle failed", { error: lastError })
  }
}

// ── Public API ──

/**
 * Start the iMessage polling loop.
 * Runs forever until stopIMessage() is called. Supervised by Pulse parent.
 */
export async function startIMessage(config: IMessageConfig): Promise<void> {
  if (running) {
    log("warn", "iMessage module already running, ignoring start request")
    return
  }

  if (!config.enabled) {
    log("info", "iMessage module disabled in config")
    return
  }

  // Apply config
  allowedHandles = new Set(config.allowed_handles ?? [])
  pollIntervalMs = config.poll_interval_ms ?? 3000
  sdkTimeoutMs = config.sdk_timeout_ms ?? 120_000

  if (allowedHandles.size === 0) {
    log("error", "No allowed handles configured — iMessage module not starting")
    return
  }

  // Verify Messages.db access
  try {
    verifyAccess()
  } catch (err) {
    lastError = String(err)
    log("error", "Cannot access ~/Library/Messages/chat.db", {
      error: lastError,
      hint: "Grant Full Disk Access to your terminal in System Settings > Privacy & Security > Full Disk Access",
    })
    return
  }

  // Ensure directories
  await mkdir(STATE_DIR, { recursive: true })
  await mkdir(LOGS_DIR, { recursive: true })

  // Initialize paths
  cursorPath = join(STATE_DIR, "cursor.json")
  chatLogPath = join(LOGS_DIR, "chat-log.md")

  // Load conversation store
  conversationStore = new ConversationStore(
    join(STATE_DIR, "conversations.json"),
  )
  await conversationStore.load()

  // Load or initialize cursor
  try {
    const cursorFile = Bun.file(cursorPath)
    if (await cursorFile.exists()) {
      const cursor = (await cursorFile.json()) as { lastRowId: number }
      lastRowId = cursor.lastRowId
    } else {
      // First run — skip all existing messages
      lastRowId = getLatestRowId()
      await saveCursor()
    }
  } catch {
    // First run — skip all existing messages
    lastRowId = getLatestRowId()
    await saveCursor()
  }

  // Reset counters
  startedAt = Date.now()
  messagesReceived = 0
  messagesResponded = 0
  lastError = undefined
  processing = false
  running = true

  log("info", "iMessage module started", {
    allowedHandles: [...allowedHandles],
    pollIntervalMs,
    sdkTimeoutMs,
    startingRowId: lastRowId,
  })

  // Initial poll
  await poll()

  // Start polling loop
  pollTimer = setInterval(poll, pollIntervalMs)

  log("info", `iMessage module polling every ${pollIntervalMs}ms`)
}

/**
 * Stop the iMessage polling loop.
 * Persists cursor before stopping.
 */
export async function stopIMessage(): Promise<void> {
  if (!running) {
    log("info", "iMessage module not running, nothing to stop")
    return
  }

  log("info", "Stopping iMessage module")

  // Clear poll timer
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }

  // Persist cursor
  await saveCursor().catch((err) =>
    log("error", "Failed to persist cursor on shutdown", { error: String(err) }),
  )

  running = false
  log("info", "iMessage module stopped", {
    uptimeMs: Date.now() - startedAt,
    messagesReceived,
    messagesResponded,
  })
}

/**
 * Return current health status.
 * Called by Pulse's health endpoint — no HTTP server here.
 */
export function imessageHealth(): IMessageHealth {
  return {
    status: running ? (lastError ? "error" : "running") : "stopped",
    uptime_ms: running ? Date.now() - startedAt : 0,
    messages_received: messagesReceived,
    messages_responded: messagesResponded,
    processing,
    last_row_id: lastRowId,
    allowed_handles: [...allowedHandles],
    poll_interval_ms: pollIntervalMs,
    ...(lastError ? { last_error: lastError } : {}),
  }
}
