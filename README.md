# opencode-telegram-notify

Telegram notifications for [opencode](https://opencode.ai) — task completion, errors, and permission requests.

```
🟩 ᴄʟᴇᴠᴇʀ-ᴄᴀʙɪɴ@ᴍʏ-ᴀᴘᴘ ᴅᴏɴᴇ (84s)
```

Zero npm dependencies, plain `fetch`. Send failures are logged to the opencode log instead of crashing your session.

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) → copy the token
2. Send any message to your bot once, then get your chat ID from `https://api.telegram.org/bot<TOKEN>/getUpdates`
3. Add the plugin and credentials:

```json
{
  "$schema": "https://opencode.ai/config.json",
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

Or use env vars instead of inline credentials: `export TELEGRAM_BOT_TOKEN=...` and `export TELEGRAM_CHAT_ID=...` in your shell profile, then restart opencode.

## Configuration

| Option     | Type                                         | Default                  | Description                                  |
| ---------- | -------------------------------------------- | ------------------------ | -------------------------------------------- |
| `botToken` | `string`                                     | `TELEGRAM_BOT_TOKEN` env | Bot token from @BotFather                     |
| `chatId`   | `string`                                     | `TELEGRAM_CHAT_ID` env   | Chat ID from step 2                           |
| `theme`    | `"linux" \| "basic"`                         | `linux`                  | Message layout — switchable via `/theme`      |
| `events`   | `Partial<EventKey, string \| false>`         | *(all enabled)*          | Custom status word per event, or `false` to mute |

Events: `session.idle` (agent finished) → `done`, `session.error` → `error`, `permission.updated` (approval requested) → `check`.

## Themes

**`linux`** (default) — one small-caps line: status box, `session@project`, status word, duration in seconds. Error messages and permission commands are printed on the next line.

```
🟩 ᴄʟᴇᴠᴇʀ-ᴄᴀʙɪɴ@ᴍʏ-ᴀᴘᴘ ᴅᴏɴᴇ (84s)
🟥 ᴄʟᴇᴠᴇʀ-ᴄᴀʙɪɴ@ᴍʏ-ᴀᴘᴘ ᴇʀʀᴏʀ (12s)
AI_APICallError: Upstream request failed
```

**`basic`** — multi-line with full details.

```
🟧 [PERMISSION REQUIRED]

📁 Project: my-app
⏱ Elapsed: 1m 10s
🔧 Type: bash
📝 Title: rm -rf node_modules && npm ci
🆔 Session: kx9f2a
🕐 16:05:23
```

## Switching theme: `/theme`

Send `/theme` to your bot while opencode is running — it replies with clickable buttons (✓ marks the current theme):

```
⏱ theme: linux
[🟩 linux ✓] [🟧 basic]
```

Tap a button to switch instantly, or type `/theme linux` / `/theme basic` directly. The choice is saved to `~/.config/opencode/telegram-notify.json`, applies to all running opencode instances, and survives restarts. Works only while opencode is open somewhere (one instance polls for the command via a lock file). Don't share the bot token with another polling bot.

## Troubleshooting

- **No messages** — did you message the bot once? Check token/chat ID; restart long-running processes after changing env vars
- **Send errors** — check `~/.local/share/opencode/log/opencode.log` for `opencode-telegram-notify` entries
- **`401 Unauthorized`** — wrong token; **`400 chat not found`** — wrong chat ID
- **Group chats** — chat ID is negative; if silent, disable privacy mode via BotFather `/setprivacy`

## License

[MIT](./LICENSE)
