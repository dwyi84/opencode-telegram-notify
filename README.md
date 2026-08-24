# opencode-telegram-notify

Get Telegram messages when your [opencode](https://opencode.ai) sessions need attention — task completion, errors, and permission requests. Walk away from the terminal without missing a thing.

```
🔐 Permission required

📁 Project: my-app
⏱ Elapsed: 1m 10s
🔧 Type: bash
📝 Title: rm -rf node_modules && npm ci
🆔 Session: kx9f2a
🕐 16:05:23
```

## Features

- **One-way notifications** via the Telegram Bot API — zero npm dependencies, plain `fetch`
- **Readable multi-line format**: project name, work duration, and event details per message
- **Configurable**: rename headers or mute individual events through options
- **Safe by design**: 5s timeout, failures are swallowed silently, missing config disables the plugin instead of crashing your session

## Setup

### 1. Create a Telegram bot

1. Open Telegram and talk to [@BotFather](https://t.me/BotFather)
2. Send `/newbot`, follow the prompts
3. Copy the bot token (looks like `123456789:AAHfW3v...`)

### 2. Get your chat ID

1. Send any message to your new bot (e.g. "hi") — this unlocks the conversation
2. Open this URL in a browser:

   ```
   https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates
   ```

3. Find `"chat": { "id": 123456789, ... }` in the response — that number is your chat ID.

**Group chats:** add the bot to the group first. The chat ID is negative (e.g. `-100123456789`). If `getUpdates` shows nothing, disable BotFather's privacy mode for the bot (`/setprivacy` → Disable), then send another message.

> Prefer `@userinfobot` if you just want your personal ID quickly.

### 3. Install the plugin

Add it to your opencode config — `~/.config/opencode/opencode.json` (global) or `opencode.json` (project):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [["opencode-telegram-notify", {}]]
}
```

> The options object is required by the config schema even when empty.

### 4. Provide credentials

Recommended — environment variables (add to your shell profile before launching opencode):

```bash
export TELEGRAM_BOT_TOKEN="123456789:AAHfW3v..."
export TELEGRAM_CHAT_ID="123456789"
```

Or inline in config:

```json
{
  "plugin": [
    [
      "opencode-telegram-notify",
      {
        "botToken": "123456789:AAHfW3v...",
        "chatId": "123456789"
      }
    ]
  ]
}
```

Avoid committing inline tokens to shared repos — use env vars.

### 5. Restart opencode

Done. Trigger any of the events and you'll get a Telegram message within seconds.

## Configuration

| Option    | Type                                            | Default                  | Description                                                                 |
| --------- | ----------------------------------------------- | ------------------------ | --------------------------------------------------------------------------- |
| `botToken` | `string`                                       | `TELEGRAM_BOT_TOKEN` env | Bot token from @BotFather                                                    |
| `chatId`  | `string`                                        | `TELEGRAM_CHAT_ID` env   | Chat ID from step 2                                                          |
| `events`  | `Partial<Record<EventKey, string \| false>>`    | *(all enabled)*          | Custom header text per event, or `false` to disable that event               |

### Events & default messages

| Event                | Fires when                       | Default header        |
| -------------------- | -------------------------------- | --------------------- |
| `session.idle`       | Agent finished its response      | ✅ **Task completed** |
| `session.error`      | Session hit an error             | ❌ **Session error**  |
| `permission.updated` | Permission approval is requested | 🔐 **Permission required** |

Example with custom headers and a muted event:

```json
[
  "opencode-telegram-notify",
  {
    "events": {
      "session.idle": "✅ 작업 끝!",
      "permission.updated": false
    }
  }
]
```

### Message fields

| Line              | Source                                                        |
| ----------------- | ------------------------------------------------------------- |
| Header            | Event type (customizable)                                     |
| 📁 Project        | Git worktree folder name                                      |
| ⏱ Duration/Elapsed | Last request start → completion (idle/error) or → now (permission); omitted if unavailable |
| 🔧 Type           | Permission kind (`bash`, `edit`, …) — permission events only  |
| 📝 Title          | Command or file being executed — permission events only       |
| 💬 Error          | First line of the error message, capped at 200 chars          |
| 🆔 Session        | Last 6 characters of the session ID                           |
| 🕐 Time           | Local time (24h)                                              |

Duplicate notifications for the same event within 1.5s are throttled.

## Troubleshooting

| Symptom                          | Fix                                                                        |
| -------------------------------- | -------------------------------------------------------------------------- |
| No messages arrive               | Did you send "hi" to the bot once? Check token/chat ID; run opencode with the env vars set |
| `401 Unauthorized`               | Wrong bot token                                                             |
| `400 chat not found`             | Wrong chat ID — re-check `getUpdates`                                       |
| Group bot silent                 | `/setprivacy` → Disable in BotFather, resend a test message                 |
| `getUpdates` returns empty       | Send a fresh message to the bot after your last API call                    |

## Related

- [opencode-event-sound](https://github.com/dwyi84/opencode-event-sound) — same events as spoken sound cues via OS TTS
- [opencode-notificator](https://github.com/panta82/opencode-notificator) — desktop notification alternative

## License

[MIT](./LICENSE)
