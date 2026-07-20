// SDD-03 INDEPENDENT acceptance tests: Question / Sub-Agent Relay.
//
// Spec: docs/specs/260719_telegram_sdd-03-question-relay.md  (## VERIFY = the
// test list; QR-1..QR-13 = WHAT/expected behavior). Master: sdd-00 (SC-2, SC-5,
// Layer A/B glossary, question bridge). Every EXPECTED value below is derived
// from the SPEC, never from an implementation body.
//
// The critical proof (V-2) is the full question round-trip: a stub executor
// invokes `Question.Service.ask` under a REAL directory-scoped
// `Instance.provide({ directory: process.cwd(), init: InstanceBootstrap })`
// (exactly as daemon/runner.ts does), the Bus bridge delivers an inline keyboard
// to the correct chat, a button callback is injected, and the parked Effect
// `Deferred` must resolve so `ask` returns the chosen option label. If the reply
// were run on a bare `AppRuntime` (no ambient Instance ALS context), the
// InstanceState.get pending-map lookup would land on a different key, the
// Deferred would never resolve, and the round-trip tests would time out (red) —
// which is the behavior QR-7/QR-13/SC-5 mandate.

import { afterEach, beforeEach, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "fs"
import { join } from "path"
import { TelegramHarness, purgeQueue, type KeyboardButton } from "../harness"
import { Question } from "../../../src/question"
import { Instance } from "../../../src/project/instance"
import { InstanceBootstrap } from "../../../src/project/bootstrap"
import { AppRuntime } from "../../../src/effect/app-runtime"
import { SessionID } from "../../../src/session/schema"
import { TelegramCorrelation } from "../../../src/telegram/correlation"
import { TelegramStore } from "../../../src/telegram/store"
import { Database } from "../../../src/storage/db"
import { TelegramSessionTable, JobQueueTable } from "../../../src/queue/queue.sql"
import { SessionTable } from "../../../src/session/session.sql"
import { ProjectTable } from "../../../src/project/project.sql"

// ---- shared Instance-scoped helpers (mirror daemon/runner.ts + SC-5) --------

const CWD = process.cwd()
const bootstrap = () => AppRuntime.runPromise(InstanceBootstrap)

/** Run `fn` inside the SAME directory-scoped instance the daemon uses (SC-5). */
function provideCwd<T>(fn: () => Promise<T>): Promise<T> {
  return Instance.provide({ directory: CWD, init: bootstrap, fn }) as unknown as Promise<T>
}

const askSvc = (input: { sessionID: SessionID; questions: Question.Info[] }) =>
  AppRuntime.runPromise(Question.Service.use((svc) => svc.ask(input)))
const listSvc = () => AppRuntime.runPromise(Question.Service.use((svc) => svc.list()))
const rejectSvc = (id: Question.Request["id"]) =>
  AppRuntime.runPromise(Question.Service.use((svc) => svc.reject(id)))

// Parked questions we started but may not have resolved; drained in afterEach so
// a reject-all cleanup does not surface as an unhandled rejection.
let parked: Promise<unknown>[] = []

/**
 * Park a question under the CWD instance exactly as the tool/runner does, then
 * return the promise `ask` yields (resolves only when the bridge replies through
 * the correctly-scoped Instance.provide path).
 */
function parkQuestion(sessionID: string, questions: Question.Info[]): Promise<Question.Answer[]> {
  const p = provideCwd(() => askSvc({ sessionID: SessionID.make(sessionID), questions }))
  parked.push(p.catch(() => {}))
  return p
}

// ---- fixtures ---------------------------------------------------------------

const OPTIONS = [
  { label: "Option A", description: "the first choice" },
  { label: "Option B", description: "the second choice" },
]

function question(header: string, opts = OPTIONS, custom?: boolean): Question.Info {
  return { question: `${header}?`, header, options: opts, ...(custom !== undefined ? { custom } : {}) }
}

/** Seed a durable chat<->session mapping via the public store API (SC-1). */
function seedChatSession(chatId: string, sessionId: string): void {
  TelegramStore.upsert(chatId)
  TelegramStore.setSession(chatId, sessionId)
}

/** Seed a bare project row (needed only because SessionTable.project_id has a FK). */
function seedProject(id: string): void {
  Database.use((db) =>
    db
      .insert(ProjectTable)
      .values({ id, worktree: "/tmp/" + id, sandboxes: [] } as any)
      .run(),
  )
}

/** Seed a session row so the parent_id walk (QR-3) has rows to traverse. */
function seedSession(id: string, projectId: string, parentId?: string): void {
  Database.use((db) =>
    db
      .insert(SessionTable)
      .values({
        id,
        project_id: projectId,
        parent_id: parentId ?? null,
        slug: "slug-" + id,
        directory: "/tmp",
        title: "t",
        version: "1",
        time_created: Date.now(),
        time_updated: Date.now(),
      } as any)
      .run(),
  )
}

// ---- keyboard-inspection helpers (echo back what the bot actually sent) -----

/** First OPTION button (callback prefix `q:` per spec HOW reuse map). Index 0. */
function firstOptionButton(h: TelegramHarness): KeyboardButton {
  const b = h.lastKeyboard().find((x) => x.callback_data.startsWith("q:"))
  if (!b) throw new Error("no option (q:) button in last keyboard")
  return b
}

/** The "type your answer" button (callback prefix `qcustom:` per spec HOW). */
function customButton(h: TelegramHarness): KeyboardButton | undefined {
  return h.lastKeyboard().find((x) => x.callback_data.startsWith("qcustom"))
}

function lastKeyboardChatId(h: TelegramHarness): string | undefined {
  const send = h.keyboardSends().at(-1)
  return send?.body?.chat_id === undefined ? undefined : String(send.body.chat_id)
}

// ---- isolation --------------------------------------------------------------

beforeEach(() => {
  purgeQueue()
  Database.use((db) => {
    db.delete(TelegramSessionTable).run()
    db.delete(SessionTable).run()
    db.delete(ProjectTable).run()
  })
})

afterEach(async () => {
  // Reject any question still parked on the CWD instance so no fiber hangs.
  await provideCwd(async () => {
    const pending = await listSvc()
    for (const req of pending) await rejectSvc(req.id)
  }).catch(() => {})
  await Promise.allSettled(parked)
  parked = []
})

// ===========================================================================
// V-1 (QR-1, QR-11): bridge exists, Layer B is gone.
// "grep ... Expected: no matches. And grep shows exactly one
//  Bus.subscribe(Question.Event.Asked ...) registration in the Telegram start path."
// ===========================================================================
test("V-1 (QR-1, QR-11): Layer B + poller symbols deleted; exactly one Event.Asked subscription", () => {
  const srcRoot = join(CWD, "src")
  const files: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.name.endsWith(".ts")) files.push(full)
    }
  }
  walk(srcRoot)

  const forbidden = [
    "globalRegister",
    "globalUnregister",
    "globalList",
    "globalReply",
    "globalReject",
    "_globalPending",
    "_globalDeferreds",
    "startQuestionPoller",
    "pollPendingQuestions",
    "_questionPollTimer",
  ]
  const hits: string[] = []
  let askedSubscriptions = 0
  const subRe = /Bus\.subscribe\(\s*Question\.Event\.Asked/
  for (const f of files) {
    const text = readFileSync(f, "utf8")
    for (const sym of forbidden) if (text.includes(sym)) hits.push(`${sym} @ ${f}`)
    // Count inbound-bridge registrations (QR-1: exactly one), ignoring matches
    // that appear inside a line comment.
    for (const line of text.split("\n")) {
      const m = subRe.exec(line)
      if (!m) continue
      const commentIdx = line.indexOf("//")
      if (commentIdx >= 0 && commentIdx < m.index) continue
      askedSubscriptions += 1
    }
  }

  expect(hits).toEqual([]) // QR-11: no Layer B / poller symbols remain
  expect(askedSubscriptions).toBe(1) // QR-1: exactly one inbound subscription

  // QR-11 (runtime): the Layer B public surface is undefined on the namespace.
  expect((Question as any).globalRegister).toBeUndefined()
  expect((Question as any).globalUnregister).toBeUndefined()
  expect((Question as any).globalList).toBeUndefined()
  expect((Question as any).globalReply).toBeUndefined()
  expect((Question as any).globalReject).toBeUndefined()
})

// ===========================================================================
// V-2 (QR-2, QR-7, QR-13, SC-5): keyboard delivered, Deferred resolved through
// the instance-scoped path, session continues. THE CRITICAL ROUND-TRIP.
// A bare AppRuntime reply would leave the Deferred parked and this test times out.
// ===========================================================================
test("V-2 (QR-2/7/13, SC-5): full question round-trip resolves the parked Deferred", async () => {
  const chat = "5201"
  const sid = "ses_v2roundtrip"
  const h = new TelegramHarness({ allowedChatIds: [chat] })

  let captured: Question.Answer[] | null = null
  // Stub executor = the daemon's runner: parks ask() under the REAL cwd instance.
  h.setRunner(async ({ sessionId, onSessionCreated }) => {
    const s = sessionId ?? sid
    if (!sessionId) onSessionCreated?.(s)
    const answers = await provideCwd(() => askSvc({ sessionID: SessionID.make(s), questions: [question("Deploy")] }))
    captured = answers
    return { sessionId: s, response: "picked:" + answers.map((a) => a.join("|")).join(";"), toolCalls: 1, durationMs: 1 }
  })

  try {
    await h.start()
    await h.startWorker()
    // Durable chat<->session mapping present before any question fires (QR-3/SC-5).
    seedChatSession(chat, sid)

    h.injectMessage(chat, "please deploy")
    await h.waitFor(() => h.jobsForChat(chat).length >= 1) // ingested (ack + enqueue)
    await h.drain() // worker claims + runs the stub executor -> ask() parks

    // QR-2/QR-5: exactly the FIRST question is delivered as a keyboard to the chat.
    await h.waitFor(() => h.keyboardSends().length >= 1)
    expect(h.keyboardSends().length).toBe(1)
    expect(lastKeyboardChatId(h)).toBe(chat) // correct chat_id
    const kb = h.lastKeyboard()
    expect(kb.some((b) => b.text.includes("Option A"))).toBe(true)
    expect(kb.some((b) => b.text.includes("Option B"))).toBe(true)
    expect(customButton(h)).toBeDefined() // "Type your answer" offered

    // Tap option 0.
    const opt0 = firstOptionButton(h)
    h.injectCallback(chat, opt0.callback_data)

    // (b) ask() returns the chosen label — proving the Deferred was succeeded
    //     via the directory-scoped Instance.provide reply (QR-7/QR-13/SC-5).
    await h.waitFor(() => captured !== null)
    expect(captured!).toEqual([["Option A"]])

    // (a) QR-9/CC-7: answered message markup edited to remove the keyboard.
    expect(h.markupEdits().length).toBeGreaterThanOrEqual(1)

    // (c) the tool output / job carries the chosen label and the session completes.
    await h.waitFor(() => h.jobForChat(chat)?.status === "done")
    const job = h.jobForChat(chat)!
    expect(job.status).toBe("done")
    expect(job.result?.response).toContain("Option A")
  } finally {
    await h.stop()
  }
})

// ===========================================================================
// V-3 (QR-3): sub-agent (child session) routes to the PARENT chat via the
// bounded parent_id walk.
// ===========================================================================
test("V-3 (QR-3): child session's question routes to the parent chat via parent_id walk", async () => {
  const chat = "5301"
  const project = "prj_v3"
  const parentSid = "ses_v3parent"
  const childSid = "ses_v3child"
  const h = new TelegramHarness({ allowedChatIds: [chat] })

  seedProject(project)
  seedSession(parentSid, project) // top-level session (chat-owning)
  seedSession(childSid, project, parentSid) // sub-agent child, NO direct mapping
  seedChatSession(chat, parentSid) // only the parent is bound to the chat

  // Deterministic: correlation walks parent_id up to the chat-owning ancestor.
  expect(TelegramCorrelation.resolveChatForSession(childSid)).toBe(chat)

  try {
    await h.start()
    const promise = parkQuestion(childSid, [question("SubAgent")])

    await h.waitFor(() => h.keyboardSends().length >= 1)
    expect(lastKeyboardChatId(h)).toBe(chat) // delivered to the PARENT chat, not dropped

    h.injectCallback(chat, firstOptionButton(h).callback_data)
    expect(await promise).toEqual([["Option A"]])
  } finally {
    await h.stop()
  }
})

// ===========================================================================
// V-4 (QR-4): scheduler-origin question is not relayed and does not error.
// ===========================================================================
test("V-4 (QR-4): question with no chat-owning ancestor is not relayed and does not throw", async () => {
  const project = "prj_v4"
  const orphanSid = "ses_v4orphan"
  const liveChat = "5402"
  const liveSid = "ses_v4live"
  const h = new TelegramHarness({ allowedChatIds: [liveChat] })

  seedProject(project)
  seedSession(orphanSid, project) // no parent, no telegram_session mapping
  // A mapped chat used only to prove the bridge/poller survived the orphan.
  seedChatSession(liveChat, liveSid)

  // Deterministic: no chat-owning ancestor -> undefined (never throws).
  expect(TelegramCorrelation.resolveChatForSession(orphanSid)).toBeUndefined()

  try {
    await h.start()

    // Park an orphan question; the bridge must NOT deliver it anywhere.
    parkQuestion(orphanSid, [question("Orphan")])
    await h.tick(4)
    expect(h.keyboardSends().length).toBe(0) // QR-4: not relayed
    expect(h.sends().length).toBe(0) // no fallback send either

    // Liveness (QR-4: "poller stays alive"): a subsequent mapped question still
    // delivers, proving the bridge handler logged-and-returned without crashing.
    const live = parkQuestion(liveSid, [question("Live")])
    await h.waitFor(() => h.keyboardSends().length >= 1)
    expect(lastKeyboardChatId(h)).toBe(liveChat)
    h.injectCallback(liveChat, firstOptionButton(h).callback_data)
    expect(await live).toEqual([["Option A"]])
  } finally {
    await h.stop()
  }
})

// ===========================================================================
// V-5 (QR-5): multiple sequential questions are sent one at a time.
// ===========================================================================
test("V-5 (QR-5): three questions sent one at a time; single reply with all answers", async () => {
  const chat = "5501"
  const sid = "ses_v5"
  const h = new TelegramHarness({ allowedChatIds: [chat] })
  seedChatSession(chat, sid)

  const q1 = question("Q1", [{ label: "A1", description: "d" }, { label: "B1", description: "d" }])
  const q2 = question("Q2", [{ label: "A2", description: "d" }, { label: "B2", description: "d" }])
  const q3 = question("Q3", [{ label: "A3", description: "d" }, { label: "B3", description: "d" }])

  try {
    await h.start()
    const promise = parkQuestion(sid, [q1, q2, q3])

    // Only the first keyboard initially.
    await h.waitFor(() => h.keyboardSends().length >= 1)
    expect(h.keyboardSends().length).toBe(1)

    // Answer q1 -> exactly one more keyboard (q2).
    h.injectCallback(chat, firstOptionButton(h).callback_data)
    await h.waitFor(() => h.keyboardSends().length >= 2)
    expect(h.keyboardSends().length).toBe(2)

    // Answer q2 -> exactly one more keyboard (q3).
    h.injectCallback(chat, firstOptionButton(h).callback_data)
    await h.waitFor(() => h.keyboardSends().length >= 3)
    expect(h.keyboardSends().length).toBe(3)

    // Answer q3 -> the outbound reply fires once, in order.
    h.injectCallback(chat, firstOptionButton(h).callback_data)
    expect(await promise).toEqual([["A1"], ["A2"], ["A3"]])
    // No extra keyboard after the last answer.
    expect(h.keyboardSends().length).toBe(3)
  } finally {
    await h.stop()
  }
})

// ===========================================================================
// V-6 (QR-6): free-text answer path.
// ===========================================================================
test("V-6 (QR-6): 'type your answer' routes the next text message into the answer", async () => {
  const chat = "5601"
  const sid = "ses_v6"
  const h = new TelegramHarness({ allowedChatIds: [chat] })
  seedChatSession(chat, sid)

  try {
    await h.start()
    await h.startWorker() // started so we can prove the text is NOT enqueued as a job
    const promise = parkQuestion(sid, [question("Custom", OPTIONS, true)])

    await h.waitFor(() => h.keyboardSends().length >= 1)
    const custom = customButton(h)
    expect(custom).toBeDefined()

    // Tap "type your answer" -> chat enters awaitingCustomAnswer for this index.
    h.injectCallback(chat, custom!.callback_data)
    await h.tick(3)

    const jobsBefore = h.jobsForChat(chat).length
    // Next text message is consumed as the free-text answer, not a new prompt.
    h.injectMessage(chat, "my custom answer")

    expect(await promise).toEqual([["my custom answer"]])
    // QR-6 precedence: the text was NOT queued as a new chat_message job.
    await h.tick(3)
    expect(h.jobsForChat(chat).length).toBe(jobsBefore)
  } finally {
    await h.stop()
  }
})

// ===========================================================================
// V-7 (QR-8): unknown/expired callback handled gracefully.
// ===========================================================================
test("V-7 (QR-8): callback for an unknown/expired requestID is acknowledged, no throw", async () => {
  const chat = "5701"
  const sid = "ses_v7"
  const h = new TelegramHarness({ allowedChatIds: [chat] })
  seedChatSession(chat, sid)

  try {
    await h.start()

    // No _pendingQuestions entry exists for this requestID (e.g. lost to restart).
    h.injectCallback(chat, "q:que_nonexistent0000000000:0")
    await h.tick(4)

    // Acknowledged, no reply attempted, no keyboard, no crash.
    expect(h.answers().length).toBeGreaterThanOrEqual(1)
    expect(h.keyboardSends().length).toBe(0)

    // Poller/bridge still alive: a real mapped question still round-trips.
    const live = parkQuestion(sid, [question("Live")])
    await h.waitFor(() => h.keyboardSends().length >= 1)
    h.injectCallback(chat, firstOptionButton(h).callback_data)
    expect(await live).toEqual([["Option A"]])
  } finally {
    await h.stop()
  }
})

// ===========================================================================
// V-8 (QR-9, CC-7): edits not spam — answered questions updated via
// editMessageReplyMarkup; no duplicate keyboard for an already-answered index.
// ===========================================================================
test("V-8 (QR-9, CC-7): answered question is edited (markup removed), not re-posted", async () => {
  const chat = "5801"
  const sid = "ses_v8"
  const h = new TelegramHarness({ allowedChatIds: [chat] })
  seedChatSession(chat, sid)

  try {
    await h.start()
    const promise = parkQuestion(sid, [question("Once")])

    await h.waitFor(() => h.keyboardSends().length >= 1)
    expect(h.keyboardSends().length).toBe(1)

    h.injectCallback(chat, firstOptionButton(h).callback_data)
    expect(await promise).toEqual([["Option A"]])

    // Keyboard removed via markup edit; no second keyboard for the same index.
    expect(h.markupEdits().length).toBeGreaterThanOrEqual(1)
    expect(h.keyboardSends().length).toBe(1)
  } finally {
    await h.stop()
  }
})

// ===========================================================================
// V-9 (QR-10, QR-13, CC-1/CC-6): restart abandons the in-flight question,
// keeps the durable mapping, and a post-restart question still round-trips.
// ===========================================================================
test("V-9 (QR-10, CC-1): restart abandons the parked Deferred; the durable mapping survives", async () => {
  const chat = "5901"
  const sid = "ses_v9"
  const h = new TelegramHarness({ allowedChatIds: [chat] })
  seedChatSession(chat, sid)

  try {
    await h.start()

    // Park a question, then simulate a daemon restart by disposing/reloading the
    // instance (fires the Layer A Question finalizer that fails parked Deferreds).
    const promise = parkQuestion(sid, [question("Lost")])
    const outcome = promise.then(
      () => "resolved" as const,
      (err) => err,
    )
    // Deterministically wait until the question is parked before restart.
    for (let i = 0; i < 100; i++) {
      const n = await provideCwd(() => listSvc())
      if (n.length >= 1) break
      await new Promise((r) => setTimeout(r, 10))
    }
    // Capture the lost requestID so we can prove a late callback is graceful.
    const lostId = (await provideCwd(() => listSvc()))[0]!.id

    await Instance.reload({ directory: CWD })

    // QR-10: unanswered questions do NOT survive a restart — the parked Deferred
    // is failed (RejectedError), never left to hang or silently resolve.
    expect(await outcome).toBeInstanceOf(Question.RejectedError)

    // CC-1: the durable chat/session correlation survives the restart.
    expect(TelegramCorrelation.resolveChatForSession(sid)).toBe(chat)

    // QR-10 -> QR-8: a late Telegram callback for the question lost to restart is
    // handled gracefully (acknowledged, no throw, no reply for a dead request).
    const answersBefore = h.answers().length
    h.injectCallback(chat, `q:${lostId}:0`)
    await h.tick(4)
    expect(h.answers().length).toBeGreaterThan(answersBefore)
  } finally {
    await h.stop()
  }
}, 30_000) // disposes + re-boots the shared instance; needs headroom over the 5s default

// GAP (V-9, second half): "the post-restart question's reply path again runs
// inside its own Instance.provide ... succeeding the new Deferred" is specified
// against a genuine FRESH PROCESS ("the fresh process re-establishes the
// directory-scoped context"). The mocked harness runs in ONE process; a
// simulated restart via in-process `Instance.reload` invalidates the
// InstanceState ScopedCache entry for process.cwd() while the persistent
// AppRuntime, the Bus, and the bridge's pre-reload `Bus.subscribe` closure all
// survive. Empirically the post-restart keyboard IS delivered (bridge + durable
// correlation survive), but the reply then lands on a different re-created
// pending map than the fresh `ask` parked on, so the new Deferred is not
// succeeded IN-PROCESS. This is a restart-simulation limitation, not a
// demonstrated production defect (a real restart is a fresh process with a fresh
// ScopedCache). The in-process round-trip WITHOUT a restart is fully proven by
// V-2. Left as a todo rather than stubbed green.
test.todo("V-9b (QR-10/QR-13): post-FRESH-PROCESS-restart new question resolves (needs real process restart)", () => {})

// ===========================================================================
// V-10 (QR-12): chat lookup reads the worker-persisted session id (SC-2).
// The chat has NO pre-seeded session_id; the worker's onSessionCreated persists
// it, and the bridge resolves the chat from that durable mapping.
// ===========================================================================
test("V-10 (QR-12): bridge resolves the chat via the worker-persisted session id", async () => {
  const chat = "6001"
  const h = new TelegramHarness({ allowedChatIds: [chat] })

  let created: string | null = null
  let captured: Question.Answer[] | null = null
  h.setRunner(async ({ sessionId, onSessionCreated }) => {
    // New chat: no resume id -> worker's onSessionCreated persists the mapping.
    const s = sessionId ?? "ses_v10_" + Date.now()
    if (!sessionId) onSessionCreated?.(s)
    created = s
    const answers = await provideCwd(() => askSvc({ sessionID: SessionID.make(s), questions: [question("Worker")] }))
    captured = answers
    return { sessionId: s, response: "picked:" + answers.map((a) => a.join("|")).join(";"), toolCalls: 1, durationMs: 1 }
  })

  try {
    await h.start()
    await h.startWorker()
    // telegram_session row exists (chat known) but session_id is NULL (new chat).
    TelegramStore.upsert(chat)

    h.injectMessage(chat, "hello")
    await h.waitFor(() => h.jobsForChat(chat).length >= 1)
    await h.drain()

    await h.waitFor(() => h.keyboardSends().length >= 1)
    // The chat was resolved purely from the durable, worker-persisted mapping.
    expect(created).not.toBeNull()
    expect(TelegramCorrelation.resolveChatForSession(created!)).toBe(chat)
    expect(lastKeyboardChatId(h)).toBe(chat)

    h.injectCallback(chat, firstOptionButton(h).callback_data)
    await h.waitFor(() => captured !== null)
    expect(captured!).toEqual([["Option A"]])
  } finally {
    await h.stop()
  }
})

// ===========================================================================
// V-11 (CC-9): typecheck + full `bun test` green. This is the repo-wide
// build/regression gate; it cannot be meaningfully asserted from inside a single
// test file (running the whole suite recursively). Verified out-of-band by the
// agent running `bun test` + typecheck and reported in the summary.
// ===========================================================================
test.todo("V-11 (CC-9): repo typecheck + full `bun test` are green (run out-of-band)", () => {})
