/**
 * Smoke test: fake OpenCode plugin context, no network. `bun test.ts`.
 * Ported from pi-continue's test.ts — no pi dependencies.
 */
export {}

const { default: plugin } = await import("./src/index.ts")

const MARKER = "[opencode-continue]"

interface Fake {
  commands: { name: string; description?: string; execute: (input: any) => Promise<void> }[]
  sent: { sessionID: string; text: string; delivery: string }[]
  logs: string[]
  events: any[]
  signal?: AbortSignal
}

function fakeContext(fake: Fake) {
  return {
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => {
        fake.signal = signal
        return {
          async *[Symbol.asyncIterator]() {
            let i = 0
            while (!signal.aborted) {
              if (i < fake.events.length) {
                yield fake.events[i++]
                continue
              }
              await new Promise((resolve) => setTimeout(resolve, 1))
            }
          },
        }
      },
    },
    command: {
      transform: async (cb: (editor: { add: (def: Fake["commands"][number]) => void }) => void) => {
        cb({ add: (def) => fake.commands.push(def) })
        return { dispose: async () => {} }
      },
    },
    session: {
      prompt: async (input: Fake["sent"][number]) => {
        fake.sent.push(input)
        return {}
      },
    },
  } as any
}

function newFake(): Fake {
  return { commands: [], sent: [], logs: [], events: [] }
}

const realLog = console.log
console.log = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].startsWith(MARKER)) {
    fakes.forEach((fake) => fake.logs.push(args.join(" ")))
    return
  }
  realLog(...args)
}
const fakes: Fake[] = []

const tick = () => new Promise((resolve) => setTimeout(resolve, 10))

let failures = 0
function assert(cond: boolean, label: string) {
  realLog(`${cond ? "PASS" : "FAIL"}  ${label}`)
  if (!cond) failures++
}

const invoke = (fake: Fake, text: string, delivery: "steer" | "queue" = "steer") => {
  const cmd = fake.commands.find((c) => c.name === "continue")!
  return cmd.execute({ sessionID: "s1", prompt: { text }, delivery })
}

async function run() {
  const fake = newFake()
  fakes.push(fake)
  const cleanup = await plugin.setup(fakeContext(fake))
  assert(fake.commands.length === 1, "registers one /continue command")
  assert(fake.commands[0].name === "continue", "command name is continue")

  // No run yet -> refuse politely.
  await invoke(fake, "")
  assert(fake.sent.length === 0, "no message sent before any run")
  assert(fake.logs.some((l) => l.includes("nothing to continue")), "pre-run refusal notifies")

  // A run settles -> /continue sends the resume instruction.
  fake.events.push({ type: "session.idle", data: { sessionID: "s1" } })
  await tick()
  await invoke(fake, "")
  assert(fake.sent.length === 1, "sends one message")
  assert(fake.sent[0].text.includes("Resume your previous task"), "resume instruction content")
  assert(fake.sent[0].delivery === "steer", "idle path uses steer delivery")
  assert(fake.logs.some((l) => l.includes("resuming (run #2)")), "resume notifies with run number")

  // Args pass through as extra instruction.
  await invoke(fake, "run the tests first")
  assert(fake.sent[1].text.includes("Extra instruction: run the tests first"), "args appended")

  // Second settle increments the counter.
  fake.events.push({ type: "session.idle", data: { sessionID: "s1" } })
  await tick()
  await invoke(fake, "")
  assert(fake.logs.some((l) => l.includes("run #3")), "run counter increments")

  // Busy agent -> queued as follow-up.
  fake.events.push({ type: "session.status", data: { sessionID: "s1", status: { type: "busy" } } })
  await tick()
  await invoke(fake, "")
  assert(fake.sent[3].delivery === "queue", "busy path queues as follow-up")
  assert(fake.logs.some((l) => l.includes("follow-up")), "busy path notifies")

  // Going idle clears the busy flag.
  fake.events.push({ type: "session.status", data: { sessionID: "s1", status: { type: "idle" } } })
  await tick()
  await invoke(fake, "")
  assert(fake.sent[4].delivery === "steer", "status idle clears busy state")

  // Caller-requested queue delivery is preserved even while idle.
  await invoke(fake, "", "queue")
  assert(fake.sent[5].delivery === "queue", "caller delivery=queue is preserved")

  // Cleanup aborts the event stream.
  await cleanup?.()
  assert(fake.signal?.aborted === true, "cleanup aborts event subscription")

  console.log = realLog
  realLog(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

await run()
