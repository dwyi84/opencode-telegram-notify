import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode-ai/plugin"

export type TelegramNotifyEvent =
  | "session.idle"
  | "session.error"
  | "permission.updated"

export type TelegramNotifyTheme = "linux" | "basic"

/**
 * Configuration:
 * - `botToken` / `chatId` fall back to the TELEGRAM_BOT_TOKEN and
 *   TELEGRAM_CHAT_ID environment variables when omitted.
 * - `theme` selects the message layout: "linux" (single terminal-style
 *   line, default) or "basic" (multi-line). The theme can also be
 *   switched at runtime by sending `/theme [linux|basic]` to the bot —
 *   the choice is persisted in ~/.config/opencode/telegram-notify.json
 *   and shared by all opencode instances.
 * - `events` maps an event key to either a custom status label or `false`
 *   to disable that event entirely.
 *
 * Telegram does not support text colors, so the green/red status colors
 * are conveyed with 🟩/🟥 markers.
 */
export interface TelegramNotifyOptions {
  botToken?: string
  chatId?: string
  theme?: TelegramNotifyTheme
  events?: Partial<Record<TelegramNotifyEvent, string | false>>
}

const THROTTLE_MS = 1500
const MAX_ERROR_CHARS = 200
const API_TIMEOUT_MS = 3000
const STATE_DIR = join(homedir(), ".config", "opencode")
const STATE_FILE = join(STATE_DIR, "telegram-notify.json")
const LOCK_FILE = join(STATE_DIR, "telegram-notify.lock")
const POLL_TIMEOUT_SEC = 10
const LOCK_STALE_MS = 30_000

type MsgInfo = { role: string; time: { created: number; completed?: number } }
type MsgEntry = { info: MsgInfo }

const STATUS: Record<
  TelegramNotifyEvent,
  { icon: string; short: string; label: string }
> = {
  "session.idle": { icon: "🟩", short: "done", label: "TASK COMPLETED" },
  "session.error": { icon: "🟥", short: "error", label: "ERROR OCCURED" },
  "permission.updated": {
    icon: "🟧",
    short: "check",
    label: "PERMISSION REQUIRED",
  },
}

const esc = (t: string) =>
  t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

function basename(p?: string): string {
  if (!p) return "unknown"
  const parts = p.split("/").filter(Boolean)
  return parts[parts.length - 1] ?? p
}

function truncate(t: string, max: number): string {
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const rs = s % 60
  const parts: string[] = []
  if (h > 0) parts.push(`${h}h`)
  if (m > 0) parts.push(`${m}m`)
  if (rs > 0 || parts.length === 0) parts.push(`${rs}s`)
  return parts.join(" ")
}

const SMALL_CAPS: Record<string, string> = {
  a: "ᴀ",
  b: "ʙ",
  c: "ᴄ",
  d: "ᴅ",
  e: "ᴇ",
  f: "ꜰ",
  g: "ɢ",
  h: "ʜ",
  i: "ɪ",
  j: "ᴊ",
  k: "ᴋ",
  l: "ʟ",
  m: "ᴍ",
  n: "ɴ",
  o: "ᴏ",
  p: "ᴘ",
  q: "ǫ",
  r: "ʀ",
  s: "s",
  t: "ᴛ",
  u: "ᴜ",
  v: "ᴠ",
  w: "ᴡ",
  x: "x",
  y: "ʏ",
  z: "ᴢ",
}

function toSmallCaps(t: string): string {
  return t.replace(/[a-z]/gi, (c) => SMALL_CAPS[c.toLowerCase()] ?? c)
}

function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    p,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

type SessionClient = {
  session: {
    messages: (o: { path: { id: string } }) => Promise<unknown>
  }
}

async function lastTurnDuration(
  client: unknown,
  sessionID: string,
): Promise<number | null> {
  try {
    const res = await raceTimeout(
      (client as SessionClient).session.messages({ path: { id: sessionID } }),
      API_TIMEOUT_MS,
    )
    const list =
      (res as { data?: MsgEntry[] }).data ?? (res as unknown as MsgEntry[])
    if (!Array.isArray(list)) return null
    let start: number | undefined
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i]?.info?.role === "user") {
        start = list[i].info.time?.created
        break
      }
    }
    if (!start) return null
    let end: number | undefined
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i]?.info?.time?.completed
      if (c) {
        end = c
        break
      }
    }
    const ms = (end ?? Date.now()) - start
    return ms >= 0 ? ms : null
  } catch {
    return null
  }
}

function normalizeTheme(v: unknown): TelegramNotifyTheme | null {
  return v === "linux" || v === "basic" ? v : null
}

function readThemeFile(): TelegramNotifyTheme | null {
  try {
    return normalizeTheme(JSON.parse(readFileSync(STATE_FILE, "utf8"))?.theme)
  } catch {
    return null
  }
}

function writeThemeFile(theme: TelegramNotifyTheme): boolean {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(STATE_FILE, `${JSON.stringify({ theme }, null, 2)}\n`)
    return true
  } catch {
    return false
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export const TelegramNotifyPlugin: Plugin = async (
  input,
  options?: TelegramNotifyOptions,
) => {
  const token = options?.botToken ?? process.env.TELEGRAM_BOT_TOKEN
  const chatId = options?.chatId ?? process.env.TELEGRAM_CHAT_ID
  const configuredTheme = normalizeTheme(options?.theme)
  const currentTheme = (): TelegramNotifyTheme =>
    readThemeFile() ?? configuredTheme ?? "linux"
  const overrides = options?.events ?? {}
  const project = basename(input.worktree ?? input.directory)
  const client = input.client
  const lastPlayed = new Map<string, number>()

  function log(level: "info" | "warn" | "error", message: string): void {
    if (!client) return
    void client.app
      .log({
        body: {
          service: "opencode-telegram-notify",
          level,
          message,
        },
      })
      .catch(() => {})
  }

  if (!token || !chatId) {
    log(
      "warn",
      "botToken/chatId missing (set TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID); plugin disabled",
    )
  }

  function api(method: string, payload: Record<string, unknown>): void {
    if (!token || !chatId) return
    void fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    })
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.text().catch(() => "")
          log(
            "error",
            `${method} failed: HTTP ${r.status} ${body.slice(0, 200)}`,
          )
        }
      })
      .catch((e: unknown) => {
        log(
          "error",
          `${method} failed: ${e instanceof Error ? e.message : String(e)}`,
        )
      })
  }

  function send(text: string, replyMarkup?: unknown): void {
    api("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    })
  }

  async function notify(
    key: TelegramNotifyEvent,
    sessionID: string | undefined,
    detail: { type?: string; title?: string; error?: string } = {},
  ): Promise<void> {
    const status = STATUS[key]
    const override = overrides[key]
    const custom = typeof override === "string" ? override : null
    const label = custom ?? status.label
    const icon = custom ? "" : status.icon

    if (currentTheme() === "linux") {
      const word = custom ?? status.short
      const ms =
        sessionID && client
          ? await lastTurnDuration(client, sessionID)
          : null
      const who = `${sessionID ? sessionID.slice(-6) : "unknown"}@${truncate(project, 20)}`
      const prefix = custom ? "" : `${status.icon} `
      const dur = ms !== null ? ` (${fmtDuration(ms)})` : ""
      const head = `${prefix}${esc(toSmallCaps(who))} ${esc(toSmallCaps(word))}${esc(toSmallCaps(dur))}`
      const extra = detail.error ?? detail.title
      send(
        extra
          ? `${head}\n${esc(extra.slice(0, MAX_ERROR_CHARS))}`
          : head,
      )
      return
    }

    const lines: string[] = [`<b>${esc(`${icon} [${label}]`.trim())}</b>`, ""]
    lines.push(`📁 Project: ${esc(project)}`)
    if (sessionID && client) {
      const ms = await lastTurnDuration(client, sessionID)
      if (ms !== null) {
        const label2 = key === "permission.updated" ? "Elapsed" : "Duration"
        lines.push(`⏱ ${label2}: ${fmtDuration(ms)}`)
      }
    }
    if (detail.type) lines.push(`🔧 Type: ${esc(detail.type)}`)
    if (detail.title) lines.push(`📝 Title: <code>${esc(detail.title)}</code>`)
    if (detail.error) lines.push(`💬 Error: ${esc(detail.error)}`)
    if (sessionID) lines.push(`🆔 Session: ${esc(sessionID.slice(-6))}`)
    lines.push(`🕐 ${new Date().toLocaleTimeString("en-GB", { hour12: false })}`)
    send(lines.join("\n"))
  }

  function lockOwned(): boolean {
    try {
      return JSON.parse(readFileSync(LOCK_FILE, "utf8"))?.pid === process.pid
    } catch {
      return false
    }
  }

  function lockFresh(): boolean {
    try {
      return Date.now() - statSync(LOCK_FILE).mtimeMs < LOCK_STALE_MS
    } catch {
      return false
    }
  }

  function acquireLock(): boolean {
    if (lockFresh() && !lockOwned()) return false
    try {
      mkdirSync(STATE_DIR, { recursive: true })
      writeFileSync(
        LOCK_FILE,
        `${JSON.stringify({ pid: process.pid, ts: Date.now() })}\n`,
      )
    } catch {
      return false
    }
    return lockOwned()
  }

  function themeKeyboard(): {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>
  } {
    const cur = currentTheme()
    return {
      inline_keyboard: [
        [
          {
            text: cur === "linux" ? "linux ✓" : "linux",
            callback_data: "theme:linux",
          },
          {
            text: cur === "basic" ? "basic ✓" : "basic",
            callback_data: "theme:basic",
          },
        ],
        [{ text: "✕ close", callback_data: "theme:close" }],
      ],
    }
  }

  function answerCallback(id: string, text: string): Promise<void> {
    return fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        callback_query_id: id,
        ...(text ? { text } : {}),
      }),
      signal: AbortSignal.timeout(5000),
    })
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.text().catch(() => "")
          log(
            "error",
            `answerCallbackQuery failed: HTTP ${r.status} ${body.slice(0, 120)}`,
          )
        }
      })
      .catch((e: unknown) => {
        log(
          "error",
          `answerCallbackQuery failed: ${e instanceof Error ? e.message : String(e)}`,
        )
      })
  }

  async function handleUpdate(
    offsetRef: { value: number },
    u: {
      update_id: number
      message?: { text?: string; chat?: { id?: number } }
      callback_query?: {
        id: string
        data?: string
        message?: { message_id: number; chat?: { id?: number } }
      }
    },
  ): Promise<void> {
    offsetRef.value = Math.max(offsetRef.value, u.update_id + 1)

    const cq = u.callback_query
    if (cq) {
      if (String(cq.message?.chat?.id) !== chatId) return
      const [ns, arg] = (cq.data ?? "").split(":")
      if (ns !== "theme") {
        await answerCallback(cq.id, "")
        return
      }
      if (arg === "close") {
        await answerCallback(cq.id, "")
        if (cq.message?.message_id) {
          api("editMessageReplyMarkup", {
            chat_id: chatId,
            message_id: cq.message.message_id,
            reply_markup: { inline_keyboard: [] },
          })
        }
        return
      }
      const target = normalizeTheme(arg)
      if (!target) {
        await answerCallback(cq.id, "unknown theme")
      } else if (target === currentTheme()) {
        await answerCallback(cq.id, `already ${target}`)
      } else if (writeThemeFile(target)) {
        await answerCallback(cq.id, `theme set: ${target}`)
      } else {
        await answerCallback(cq.id, "failed to write state file")
      }
      if (cq.message?.message_id) {
        api("editMessageReplyMarkup", {
          chat_id: chatId,
          message_id: cq.message.message_id,
          reply_markup: themeKeyboard(),
        })
      }
      return
    }

    const msg = u.message
    if (!msg?.text || String(msg.chat?.id) !== chatId) return
    const parts = msg.text.trim().split(/\s+/)
    if (parts[0].split("@")[0] !== "/theme") return
    const arg = normalizeTheme(parts[1])
    if (!arg) {
      send(`⏱ theme: ${currentTheme()}`, themeKeyboard())
    } else if (arg === currentTheme()) {
      send(`⏱ theme: already ${arg}`)
    } else if (writeThemeFile(arg)) {
      send(`⏱ theme set: ${arg}`)
    } else {
      send(`⚠️ failed to write ${STATE_FILE}`)
    }
  }

  async function pollLoop(): Promise<void> {
    const offsetRef = { value: 0 }
    while (lockOwned()) {
      try {
        try {
          mkdirSync(STATE_DIR, { recursive: true })
          writeFileSync(
            LOCK_FILE,
            `${JSON.stringify({ pid: process.pid, ts: Date.now() })}\n`,
          )
        } catch {}
        const r = await fetch(
          `https://api.telegram.org/bot${token}/getUpdates?timeout=${POLL_TIMEOUT_SEC}&offset=${offsetRef.value}&allowed_updates=${encodeURIComponent('["message","callback_query"]')}`,
          { signal: AbortSignal.timeout(POLL_TIMEOUT_SEC * 1000 + 5000) },
        )
        const body = (await r.json()) as {
          ok?: boolean
          result?: Array<{
            update_id: number
            message?: { text?: string; chat?: { id?: number } }
            callback_query?: {
              id: string
              data?: string
              message?: { message_id: number; chat?: { id?: number } }
            }
          }>
        }
        if (!body?.ok || !Array.isArray(body.result)) {
          await sleep(5000)
          continue
        }
        for (const u of body.result) {
          await handleUpdate(offsetRef, u)
        }
      } catch {
        await sleep(5000)
      }
    }
  }

  async function registerCommands(): Promise<void> {
    try {
      await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commands: [
            {
              command: "theme",
              description: "Switch notification theme (linux | basic)",
            },
          ],
        }),
        signal: AbortSignal.timeout(5000),
      })
    } catch {}
  }

  async function pollLifecycle(): Promise<void> {
    while (true) {
      if (!acquireLock()) {
        // another instance owns the (fresh) lock — retry until it goes away
        await sleep(20_000)
        continue
      }
      await registerCommands()
      await pollLoop()
      // lost ownership (owner restart race) — fall back to follower retry
      await sleep(20_000)
    }
  }

  if (token && chatId) {
    void pollLifecycle()
  }

  return {
    event: async ({ event }) => {
      const key = event.type
      if (
        key !== "session.idle" &&
        key !== "session.error" &&
        key !== "permission.updated"
      )
        return
      const override = overrides[key]
      if (override === false) return

      const props = (
        event as unknown as { properties?: Record<string, unknown> }
      ).properties
      const throttleKey = `${key}:${String(props?.sessionID ?? "")}`
      const now = Date.now()
      for (const [k, ts] of lastPlayed) {
        if (now - ts >= THROTTLE_MS * 20) lastPlayed.delete(k)
      }
      if (now - (lastPlayed.get(throttleKey) ?? 0) < THROTTLE_MS) return
      lastPlayed.set(throttleKey, now)

      if (key === "permission.updated") {
        await notify(key, props?.sessionID as string | undefined, {
          type: props?.type ? String(props.type) : undefined,
          title: props?.title ? String(props.title) : undefined,
        })
        return
      }

      if (key === "session.error") {
        const err = props?.error as { message?: string } | undefined
        const msg = err?.message?.split("\n")[0].slice(0, MAX_ERROR_CHARS)
        await notify(key, props?.sessionID as string | undefined, {
          error: msg || undefined,
        })
        return
      }

      await notify(key, props?.sessionID as string | undefined)
    },
  }
}

export default TelegramNotifyPlugin
