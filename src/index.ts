import type { Plugin } from "@opencode-ai/plugin"

export type TelegramNotifyEvent =
  | "session.idle"
  | "session.error"
  | "permission.updated"

/**
 * Configuration:
 * - `botToken` / `chatId` fall back to the TELEGRAM_BOT_TOKEN and
 *   TELEGRAM_CHAT_ID environment variables when omitted.
 * - `events` maps an event key to either a custom header string or `false`
 *   to disable that event entirely.
 */
export interface TelegramNotifyOptions {
  botToken?: string
  chatId?: string
  events?: Partial<Record<TelegramNotifyEvent, string | false>>
}

const THROTTLE_MS = 1500
const MAX_ERROR_CHARS = 200
const DURATION_TIMEOUT_MS = 3000

type MsgInfo = { role: string; time: { created: number; completed?: number } }
type MsgEntry = { info: MsgInfo }

const esc = (t: string) =>
  t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

function basename(p?: string): string {
  if (!p) return "unknown"
  const parts = p.split("/").filter(Boolean)
  return parts[parts.length - 1] ?? p
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`
  const h = Math.floor(m / 60)
  return `${h}h ${String(m % 60).padStart(2, "0")}m`
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

async function lastTurnDuration(
  client: unknown,
  sessionID: string,
): Promise<number | null> {
  try {
    const res = await raceTimeout(
      (
        client as {
          session: {
            messages: (o: { path: { id: string } }) => Promise<unknown>
          }
        }
      ).session.messages({ path: { id: sessionID } }),
      DURATION_TIMEOUT_MS,
    )
    const list =
      (res as { data?: MsgEntry[] }).data ??
      (res as unknown as MsgEntry[])
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

export const TelegramNotifyPlugin: Plugin = async (
  input,
  options?: TelegramNotifyOptions,
) => {
  const token = options?.botToken ?? process.env.TELEGRAM_BOT_TOKEN
  const chatId = options?.chatId ?? process.env.TELEGRAM_CHAT_ID
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

  function send(text: string): void {
    if (!token || !chatId) return
    void fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(5000),
    })
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.text().catch(() => "")
          log("error", `sendMessage failed: HTTP ${r.status} ${body.slice(0, 200)}`)
        }
      })
      .catch((e: unknown) => {
        log(
          "error",
          `sendMessage failed: ${e instanceof Error ? e.message : String(e)}`,
        )
      })
  }

  async function notify(
    key: TelegramNotifyEvent,
    header: string,
    sessionID: string | undefined,
    extraLines: string[],
    durationLabel: "Duration" | "Elapsed" | null,
  ): Promise<void> {
    const lines: string[] = [`<b>${esc(header)}</b>`, ""]
    lines.push(`📁 Project: ${esc(project)}`)
    if (durationLabel && sessionID) {
      const ms = await lastTurnDuration(client, sessionID)
      if (ms !== null) lines.push(`⏱ ${durationLabel}: ${fmtDuration(ms)}`)
    }
    lines.push(...extraLines)
    if (sessionID) lines.push(`🆔 Session: ${esc(sessionID.slice(-6))}`)
    lines.push(`🕐 ${new Date().toLocaleTimeString("en-GB", { hour12: false })}`)
    send(lines.join("\n"))
  }

  return {
    event: async ({ event }) => {
      const key = event.type
      if (key !== "session.idle" && key !== "session.error" && key !== "permission.updated")
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
        await notify(
          key,
          typeof override === "string" ? override : "Permission required",
          props?.sessionID as string | undefined,
          [
            ...(props?.type
              ? [`🔧 Type: ${esc(String(props.type))}`]
              : []),
            ...(props?.title
              ? [`📝 Title: <code>${esc(String(props.title))}</code>`]
              : []),
          ],
          "Elapsed",
        )
        return
      }

      if (key === "session.error") {
        const err = props?.error as { message?: string } | undefined
        const msg = err?.message?.split("\n")[0].slice(0, MAX_ERROR_CHARS)
        await notify(
          key,
          typeof override === "string" ? override : "Session error",
          props?.sessionID as string | undefined,
          msg ? [`💬 Error: ${esc(msg)}`] : [],
          "Duration",
        )
        return
      }

      await notify(
        key,
        typeof override === "string" ? override : "Task completed",
        props?.sessionID as string | undefined,
        [],
        "Duration",
      )
    },
  }
}

export default TelegramNotifyPlugin
