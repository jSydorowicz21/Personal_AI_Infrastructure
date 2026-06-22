/**
 * PAI Pulse — Telegram Module
 *
 * grammY polling bot absorbed into Pulse as a long-running module.
 * Does NOT create its own HTTP server — health is reported via the
 * parent's /health endpoint using telegramHealth().
 *
 * Architecture: grammY polling -> auth -> active framework inference -> Telegram
 */

import { Bot } from "grammy"
import { ConversationStore } from "../lib/conversation"
import { sanitize, analyzeForInjection } from "../lib/sanitize"
import { join } from "path"
import { appendFile, mkdir } from "fs/promises"
import { memoryPath } from "../../TOOLS/lib/paths"
import { inference } from "../../TOOLS/Inference"

// BILLING: Strip Anthropic API credentials so framework inference cannot
// accidentally fall back to API-key billing in Claude compatibility mode.
delete process.env.ANTHROPIC_API_KEY
delete process.env.ANTHROPIC_AUTH_TOKEN

// ── Config Interface ──

export interface TelegramConfig {
  enabled: boolean
  bot_token?: string
  allowed_users?: number[]
  max_turns?: number
  sdk_timeout_ms?: number
  edit_interval_ms?: number
}

// ── Constants ──

const STATE_DIR = memoryPath("STATE", "pulse", "telegram")
const LOGS_DIR = memoryPath("OBSERVABILITY", "pulse", "telegram")
const MAX_TELEGRAM_LENGTH = 4096
const TELEGRAM_SYSTEM_PROMPT = `You are {{DA_NAME}}, responding via Telegram. {{PRINCIPAL_NAME}} is messaging you from his phone.

CRITICAL RULES FOR TELEGRAM MODE:
- Ignore terminal-only Algorithm, Native, and Minimal format templates.
- No format headers, no emoji prefixes, and no voice notification curls.
- Speak naturally and keep responses under 200 words.
- No code blocks unless specifically asked for code.
- When doing tasks, do them and confirm briefly what you did.`

// ── Module State ──

let bot: Bot | null = null
let conversationStore: ConversationStore | null = null
let processing = false
let startedAt = 0
let messagesReceived = 0
let messagesResponded = 0
let activeConfig: TelegramConfig | null = null

// ── Logging ──

function log(level: "info" | "warn" | "error", msg: string, data?: unknown) {
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    component: "telegram",
    msg,
    ...(data ? { data } : {}),
  })
  console.log(entry)
}

// ── Chat Log ──

async function appendChatLog(userMsg: string, botMsg: string) {
  const chatLogPath = join(LOGS_DIR, "chat-log.md")
  const ts = new Date().toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  })
  const entry = `\n### ${ts}\n**{{PRINCIPAL_NAME}}:** ${userMsg}\n\n**{{DA_NAME}}:** ${botMsg}\n\n---\n`
  await appendFile(chatLogPath, entry).catch(() => {})
}

// ── Exports ──

/**
 * Start the Telegram bot polling loop.
 * Runs forever until stopTelegram() is called or parent terminates.
 */
export async function startTelegram(config: TelegramConfig): Promise<void> {
  if (!config.enabled) {
    log("info", "Telegram module disabled")
    return
  }

  const token = config.bot_token ?? process.env.TELEGRAM_BOT_TOKEN
  if (!token) {
    log("error", "No bot token — set bot_token in config or TELEGRAM_BOT_TOKEN in env")
    return
  }

  const allowedUsers = new Set(
    config.allowed_users?.length
      ? config.allowed_users
      : (process.env.TELEGRAM_ALLOWED_USERS ?? process.env.TELEGRAM_PRINCIPAL_CHAT_ID ?? "")
          .split(",")
          .map(s => s.trim())
          .filter(Boolean)
          .map(Number)
  )

  if (allowedUsers.size === 0) {
    log("error", "No allowed users configured")
    return
  }

  const sdkTimeoutMs = config.sdk_timeout_ms ?? 120_000
  // Ensure directories
  await mkdir(STATE_DIR, { recursive: true })
  await mkdir(LOGS_DIR, { recursive: true })

  // Initialize conversation store
  conversationStore = new ConversationStore(join(STATE_DIR, "conversations.json"))
  await conversationStore.load()

  // Create bot
  activeConfig = config
  startedAt = Date.now()
  messagesReceived = 0
  messagesResponded = 0
  processing = false

  bot = new Bot(token)

  // Auth middleware
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id
    if (!userId || !allowedUsers.has(userId)) {
      log("warn", "Rejected message from unauthorized user", { userId, username: ctx.from?.username })
      return
    }
    await next()
  })

  // Message handler — sequential processing
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text
    const userId = ctx.from.id
    const chatId = ctx.chat.id

    messagesReceived++
    log("info", "Message received", { userId, chatId, textLength: text.length })

    // Sanitize input
    const sanitized = sanitize(text)
    if (!sanitized) return

    const injection = analyzeForInjection(sanitized)
    if (injection.riskLevel === "CRITICAL") {
      log("warn", "Blocked CRITICAL injection attempt", { userId, patterns: injection.matchedPatterns })
      await ctx.reply("Message blocked for security reasons.")
      return
    }

    // Sequential processing — one message at a time
    if (processing) {
      await ctx.reply("Still processing your previous message. Please wait.")
      return
    }

    processing = true
    const startTime = Date.now()

    try {
      // Typing indicator
      await ctx.api.sendChatAction(chatId, "typing").catch(() => {})

      // Build prompt with conversation history context
      const history = conversationStore!.getHistory()
      let prompt = sanitized
      if (history.length > 0) {
        const historyText = history
          .slice(-10) // Last 5 exchanges for context
          .map(m => `${m.role === "user" ? "Principal" : "DA"}: ${m.content}`)
          .join("\n")
        prompt = `Previous conversation:\n${historyText}\n\nPrincipal's new message: ${sanitized}`
      }

      // Collect response with timeout
      let fullText = ""

      const result = await inference({
        systemPrompt: TELEGRAM_SYSTEM_PROMPT,
        userPrompt: prompt,
        level: "standard",
        timeout: sdkTimeoutMs,
      })
      if (result.success) {
        fullText = result.output
        log("info", "Framework inference complete", { durationMs: Date.now() - startTime, level: result.level })
      } else {
        log("error", "Framework inference failed", { error: result.error })
      }

      if (!fullText) {
        fullText = "Sorry, I wasn't able to generate a response. Try again?"
        log("error", "Empty response from AI backend")
      }

      // Final clean message
      if (fullText.length <= MAX_TELEGRAM_LENGTH) {
        await ctx.reply(fullText)
      } else {
        // Split long messages
        const chunks: string[] = []
        let remaining = fullText
        while (remaining.length > 0) {
          chunks.push(remaining.slice(0, MAX_TELEGRAM_LENGTH))
          remaining = remaining.slice(MAX_TELEGRAM_LENGTH)
        }
        for (const chunk of chunks) {
          await ctx.reply(chunk)
        }
      }

      messagesResponded++
      log("info", "Response sent", { durationMs: Date.now() - startTime, responseLength: fullText.length })

      // Persist conversation
      await conversationStore!.addExchange(sanitized, fullText)
      await appendChatLog(sanitized, fullText)

    } catch (err) {
      log("error", "Message processing failed", { error: String(err) })
      await ctx.reply("Something went wrong processing your message. Try again?").catch(() => {})
    } finally {
      processing = false
    }
  })

  // Start polling — await keeps startTelegram() alive until bot.stop() is called.
  // Without await, the supervisor thinks the function exited and restarts it,
  // causing a grammY 409 conflict (two polling loops on the same bot token).
  log("info", "Starting Telegram polling", { allowedUsers: [...allowedUsers] })

  await bot.start({
    onStart: (info) => {
      log("info", `Bot started: @${info.username}`, { botId: info.id })
    },
  })
}

/**
 * Stop the Telegram bot gracefully.
 */
export async function stopTelegram(): Promise<void> {
  if (!bot) return
  log("info", "Stopping Telegram bot")
  bot.stop()
  bot = null
  activeConfig = null
  log("info", "Telegram bot stopped")
}

/**
 * Return health status for the parent's /health endpoint.
 */
export function telegramHealth(): {
  status: "running" | "stopped" | "disabled"
  uptime_ms: number
  messages_received: number
  messages_responded: number
  processing: boolean
} {
  if (!bot) {
    return {
      status: activeConfig?.enabled === false ? "disabled" : "stopped",
      uptime_ms: 0,
      messages_received: 0,
      messages_responded: 0,
      processing: false,
    }
  }

  return {
    status: "running",
    uptime_ms: Date.now() - startedAt,
    messages_received: messagesReceived,
    messages_responded: messagesResponded,
    processing,
  }
}
