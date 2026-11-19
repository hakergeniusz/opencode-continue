# opencode-continue

One command, one job: pick the task back up. A native OpenCode V2 rewrite of
[`pi-continue`](https://github.com/hakergeniusz/pi-continue).

```
/continue            resume the previous run where it left off
/continue <text>     resume, with an extra instruction
```

The session transcript already holds everything — what the agent did, what it
learned, what is still open. So `/continue` repeats none of that; it sends one
nudge ("resume from exactly where you left off, don't redo finished work")
through `ctx.session.prompt`, which triggers a new turn.

Details:

- `/continue` before any agent run in the session refuses politely instead of
  sending the agent into a void.
- While the agent is still running, the message is delivered as a **queued
  follow-up** (`delivery: "queue"`) rather than steering mid-thought.
- Anything typed after the command is passed along as an extra instruction, so
  `/continue run the tests first` reads naturally.
- Run and busy state are tracked per session from the server event stream, so
  concurrent sessions do not interfere.

## How it maps from the pi original

| pi extension | OpenCode V2 plugin |
|---|---|
| `pi.registerCommand("continue", …)` | `ctx.command.transform((editor) => editor.add({ name: "continue", … }))` |
| `pi.on("agent_settled")` counting runs | `ctx.event.subscribe({ types: ["session.idle", "session.status"] })` |
| `ctx.isIdle()` check | `session.status` events (`busy` / `retry` vs `idle`) tracked per session |
| `pi.sendUserMessage(content)` | `ctx.session.prompt({ sessionID, text, delivery: "steer" })` |
| `pi.sendUserMessage(content, { deliverAs: "followUp" })` | `ctx.session.prompt({ …, delivery: "queue" })` |
| `ctx.ui.notify(text, "info")` | `console.log` on the server (see Known gaps) |
| extension load / unload | plugin `setup` / its returned cleanup function (`controller.abort()`) |

## Install

Add the plugin directory to `opencode.json(c)`:

```jsonc
{
  "plugins": ["./plugins/opencode-continue"]
}
```

Or publish it and reference the package:

```jsonc
{
  "plugins": ["opencode-continue"]
}
```

Plugins under `.opencode/plugins/` load automatically.

## Verify

```bash
bun install
bun continue.test.ts   # smoke test with a fake plugin context, no network
bunx tsc --noEmit      # strict type-check against @opencode/plugin
```

## Known gaps

- **Notifications.** pi's `ctx.ui.notify` showed an info toast. The OpenCode
  *server* part has no toast/notification API, so the three status messages are
  written to the server log with an `[opencode-continue]` prefix instead. A TUI
  part could reproduce the toast, but that would require bridging server state
  to the TUI; it is intentionally omitted to keep this plugin self-contained
  and free of duplicate command dispatch.
- **Counter lifetime.** Like the original's in-memory counter, run counts start
  at zero when the plugin (re)loads. Runs that finished before the plugin was
  enabled are not counted, so `/continue` will refuse until the next run.

MIT licensed. Copyright (c) 2026 hakergeniusz.
