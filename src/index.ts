/**
 * continue — one command, one job: pick the task back up.
 *
 * The session transcript already holds everything the agent needs: what it
 * did, what it learned, what is still open. So `/continue` repeats none of
 * that — it sends one nudge that says "keep going from where you stopped".
 *
 * Anything typed after the command is passed through as an extra instruction,
 * so `/continue run the tests first` still reads naturally.
 *
 * Two small courtesies:
 *   - `/continue` before any run in the session says so instead of sending the
 *     agent into a void.
 *   - `/continue` while the agent is still running queues the message as a
 *     follow-up rather than steering mid-thought.
 */
import { Plugin } from "@opencode/plugin"

const MARKER = "[opencode-continue]"

const RESUME_INSTRUCTION =
  `${MARKER} Resume your previous task from exactly where you left off. ` +
  "Do not redo completed work or re-explain the task; pick up the next pending " +
  "step and carry it to completion."

export default Plugin.define({
  id: "opencode-continue",
  async setup(ctx) {
    const controller = new AbortController()

    // pi tracked `agent_settled` in memory. OpenCode emits `session.idle` when
    // an agent loop finishes a run, and `session.status` as it goes busy/idle.
    // Both are scoped per session so multiple concurrent sessions stay separate.
    const runs = new Map<string, number>()
    const busy = new Set<string>()

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          types: ["session.idle", "session.status"],
          signal: controller.signal,
        })) {
          if (event.type === "session.idle") {
            const sessionID = event.data.sessionID
            runs.set(sessionID, (runs.get(sessionID) ?? 0) + 1)
            busy.delete(sessionID)
          } else if (event.type === "session.status") {
            const sessionID = event.data.sessionID
            if (event.data.status.type === "idle") busy.delete(sessionID)
            else busy.add(sessionID)
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          console.error(`${MARKER} event subscription ended:`, error)
        }
      }
    })()

    const notify = (text: string) => {
      // pi's `ctx.ui.notify` is a TUI facility; the OpenCode server part has no
      // toast/notify API. Log to the server log instead — see README "Known gaps".
      console.log(`${MARKER} ${text}`)
    }

    await ctx.command.transform((editor) => {
      editor.add({
        name: "continue",
        description:
          "Continue the previous task where it left off. Extra text is passed along as an instruction",
        execute: async ({ sessionID, prompt, delivery }) => {
          const settled = runs.get(sessionID) ?? 0
          if (settled === 0) {
            notify("nothing to continue yet — no agent run in this session")
            return
          }

          const extra = prompt.text.trim()
          const text = extra
            ? `${RESUME_INSTRUCTION}\nExtra instruction: ${extra}`
            : RESUME_INSTRUCTION

          const isBusy = busy.has(sessionID)
          await ctx.session.prompt({
            ...prompt,
            sessionID,
            text,
            delivery: isBusy || delivery === "queue" ? "queue" : "steer",
          })

          notify(
            isBusy
              ? "agent still running — queued as follow-up"
              : `resuming (run #${settled + 1})`,
          )
        },
      })
    })

    // Aborting the signal ends the event stream when the plugin unloads.
    return () => controller.abort()
  },
})
