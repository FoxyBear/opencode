// ============================================================================
// INDEPENDENT acceptance tests for SDD-02
//   "Runtime Model Control + Katya Security Guard"
//   spec: docs/specs/260719_telegram_sdd-02-model-control.md  (## VERIFY V1..V10)
//   master: docs/specs/260719_telegram_sdd-00-master.md       (SEC-1..4, SC-4)
//
// SECURITY-CRITICAL. Every expected outcome below is derived from the SPEC
// (the WHAT requirements and the restated SEC-1..4), NOT from reading the
// implementation bodies (persona/policy.ts, persona/session.ts, daemon/runner.ts,
// telegram/bot.ts were treated as opaque; only their exported SIGNATURES were
// referenced, per the spec HOW). Expectations are NOT copied from the existing
// implementation-aware test/persona/security.test.ts.
//
// The Katya invariant under test (SEC-1, master §Security):
//   A deny-policy persona can NEVER resolve to an anthropic/* or openai/* model
//   via ANY path — chat override, persona frontmatter, or default fallback — and
//   when a denied model would be used the guard THROWS before sdk.session.prompt
//   is ever reached (so prompt is called ZERO times).
//
// Observability of "zero prompt calls": the spec HOW pins the choke point at the
// exported `Runner.resolveEffectiveModel` (docs/specs SDD-02 HOW item 4; it is
// invoked as the LAST statement before `sdk.session.prompt` in the daemon
// executor). A throw from `resolveEffectiveModel` therefore provably prevents the
// prompt from being sent. The executor's private `sdk` cannot be spied without a
// live provider/Instance context, so the documented choke point is the strongest
// available seam and is exactly the one the spec names for this assertion.
// ============================================================================

import { describe, test, expect, beforeAll, beforeEach } from "bun:test"
import path from "path"
import fs from "fs/promises"

import { Global } from "../../../src/global"
import { Persona, type PersonaConfig } from "../../../src/persona/index"
import { PersonaPolicy } from "../../../src/persona/policy"
import { PersonaSession } from "../../../src/persona/session"
import { Runner } from "../../../src/daemon/runner"
import type { RunModel } from "../../../src/daemon/headless"
import { TelegramHarness, purgeQueue } from "../harness"
import { TelegramStore } from "../../../src/telegram/store"
import { TelegramBot } from "../../../src/telegram/bot"

// ---- fixtures --------------------------------------------------------------

// The FIXTURE Katya persona: denies the two forbidden families and pins an
// allowed default on a different provider (deepseek). This is the shape the
// master §Security invariant is about.
const KATYA_MD = [
  "---",
  "name: katya",
  "model: deepseek/deepseek-chat",
  "models:",
  '  deny: ["anthropic/*", "openai/*"]',
  '  allow: ["deepseek/*"]',
  "---",
  "I am Katya.",
].join("\n")

// A persona with NO `models` frontmatter and NO `model` (non-policy control).
const PLAIN_MD = ["---", "name: plainpersona", "---", "Plain."].join("\n")

// A deny-only persona for the Amendment A picker tests: it keeps the Katya
// security boundary (anthropic/openai denied) but has NO allow-list, so a diverse
// catalog (deepinfra/llama-*, deepseek/*, etc.) is allowed and can be searched,
// paginated, and long-key-tested. All VA harness tests run against this persona.
const PICKER_MD = [
  "---",
  "name: pickerpersona",
  "model: deepseek/deepseek-chat",
  "models:",
  '  deny: ["anthropic/*", "openai/*"]',
  "---",
  "I am the picker persona.",
].join("\n")

async function writePersonaFile(name: string, body: string): Promise<void> {
  const dir = path.join(Global.Path.config, "personas")
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${name}.md`), body)
}

// Build a ResolvedPersona literal whose policy lives ONLY under `.config.models`
// (ResolvedPersona has no top-level `models` field — persona/session.ts). Passing
// this to the guard is the field-path regression probe of SC-4: a guard that read
// the non-existent `resolvedPersona.models` would see `undefined` and NOT throw.
function resolvedPersona(config: PersonaConfig, frontmatterModel?: string): PersonaSession.ResolvedPersona {
  return { name: config.name, config, systemPrompt: config.content, model: frontmatterModel }
}

// A resolveDefault stub that returns an ALLOWED default and records if it ran.
function allowedDefault(): { fn: () => Promise<RunModel>; calls: number } {
  const box = { calls: 0 }
  const fn = async () => {
    box.calls++
    return { providerID: "deepseek", modelID: "deepseek-chat" }
  }
  return { fn, get calls() { return box.calls } }
}

// A resolveDefault stub that returns a DENIED default (simulating the today's
// Anthropic/OpenAI-biased Provider.defaultModel fallback hole, WHAT 6).
const deniedDefault = async (): Promise<RunModel> => ({ providerID: "anthropic", modelID: "claude-sonnet-4-5" })

// Assert an async fn rejects, and that the rejection is the expected NamedError.
async function expectRejects(fn: () => Promise<unknown>, errName: string): Promise<any> {
  let caught: any = undefined
  try {
    await fn()
  } catch (e) {
    caught = e
  }
  expect(caught, `expected a throw of ${errName}, but the call resolved`).toBeDefined()
  expect(caught?.name ?? caught?.constructor?.name).toBe(errName)
  return caught
}

// Unique chat ids: the process-wide :memory: telegram_session table is shared.
let _chatSeq = 0
function chatId(tag: string): string {
  return `sdd02-${tag}-${Date.now()}-${_chatSeq++}`
}

beforeAll(async () => {
  await writePersonaFile("katya", KATYA_MD)
  await writePersonaFile("plainpersona", PLAIN_MD)
  await writePersonaFile("pickerpersona", PICKER_MD)
})

beforeEach(() => {
  PersonaSession._resetAll()
})

// ============================================================================
// V1 — persona policy parse (WHAT 1)
// "WHEN a persona file is parsed, the system SHALL read frontmatter object
//  `models: { allow?; deny? }` ... and expose it on PersonaConfig.models; WHEN
//  the frontmatter omits `models`, the field SHALL be `undefined`."
// (parsePersonaFile is not exported; exercised through the public Persona.load,
//  which parses the on-disk fixture.)
// ============================================================================
describe("V1 — persona policy parse (WHAT 1)", () => {
  test("models.deny/allow are parsed onto PersonaConfig.models", async () => {
    const config = await Persona.load("katya")
    expect(config.models?.deny).toEqual(["anthropic/*", "openai/*"])
    expect(config.models?.allow).toEqual(["deepseek/*"])
  })

  test("a persona with no `models` key yields config.models === undefined", async () => {
    const config = await Persona.load("plainpersona")
    expect(config.models).toBeUndefined()
  })
})

// ============================================================================
// V2 — glob matching + precedence (WHAT 2-4)
// WHAT 3: deny takes precedence over allow.
// WHAT 4: allow present + unmatched => forbidden; allow absent => allowed unless denied.
// ============================================================================
describe("V2 — glob matching + deny/allow precedence (WHAT 2-4)", () => {
  const policy = { deny: ["anthropic/*"], allow: ["deepseek/*"] }

  test("allowed provider inside allow-list and outside deny => true", () => {
    expect(PersonaPolicy.isModelAllowed(policy, "deepseek/deepseek-chat")).toBe(true)
  })

  test("model matching a deny glob => false (WHAT 3)", () => {
    expect(PersonaPolicy.isModelAllowed(policy, "anthropic/claude-sonnet-4-5")).toBe(false)
  })

  test("model not matching any allow glob => false (allow acts as allowlist, WHAT 4)", () => {
    expect(PersonaPolicy.isModelAllowed(policy, "openai/gpt-5")).toBe(false)
  })

  test("deny-only policy: a non-denied model is allowed (WHAT 4, allow absent)", () => {
    expect(PersonaPolicy.isModelAllowed({ deny: ["anthropic/*"] }, "openai/gpt-5")).toBe(true)
  })

  test("deny wins over a wildcard allow (WHAT 3)", () => {
    expect(PersonaPolicy.isModelAllowed({ allow: ["*"], deny: ["anthropic/*"] }, "anthropic/claude-x")).toBe(false)
  })

  test("bare `*` and trailing `*` are the only wildcards (WHAT 2)", () => {
    expect(PersonaPolicy.matchesGlob("openai/gpt-5-mini", "openai/gpt-5*")).toBe(true)
    expect(PersonaPolicy.matchesGlob("openai/gpt-5-mini", "openai/*")).toBe(true)
    expect(PersonaPolicy.matchesGlob("deepseek/deepseek-chat", "*")).toBe(true)
    // Anchored: a deny of anthropic/* must NOT leak onto a different provider.
    expect(PersonaPolicy.matchesGlob("deepseek/deepseek-chat", "anthropic/*")).toBe(false)
  })
})

// ============================================================================
// V6 — persona with a policy but no valid model FAILS validation (WHAT 9-10, SEC-2, SC-4)
// SEC-2: "a persona that declares a deny list SHALL be validated to also declare
//   an allowed default `model`; a persona that could resolve to a denied provider
//   SHALL fail loudly at validation time." SC-4 extends this to allow-only personas.
// The resolution SHALL NOT return a persona / fall through to an unconstrained default.
// ============================================================================
describe("V6 — SEC-2 first-use validation fails loudly (WHAT 9-10, SC-4)", () => {
  const V = "PersonaPolicyValidationError"

  test("deny-list persona with NO frontmatter model => throws, no persona returned", async () => {
    const err = await expectRejects(
      () =>
        PersonaSession.resolve("katya", [], {
          load: async () => ({ name: "katya", models: { deny: ["anthropic/*", "openai/*"] }, content: "x" }),
        }),
      V,
    )
    expect(err.data?.persona ?? JSON.stringify(err.data)).toContain("katya")
  })

  test("deny-list persona whose frontmatter model is itself denied => throws", async () => {
    await expectRejects(
      () =>
        PersonaSession.resolve("katya", [], {
          load: async () => ({
            name: "katya",
            model: "anthropic/claude-sonnet-4-5",
            models: { deny: ["anthropic/*", "openai/*"] },
            content: "x",
          }),
        }),
      V,
    )
  })

  test("allow-only persona with NO frontmatter model => throws (SC-4)", async () => {
    await expectRejects(
      () =>
        PersonaSession.resolve("k", [], {
          load: async () => ({ name: "k", models: { allow: ["deepseek/*"] }, content: "x" }),
        }),
      V,
    )
  })

  test("allow-only persona whose model falls OUTSIDE the allow list => throws (SC-4)", async () => {
    await expectRejects(
      () =>
        PersonaSession.resolve("k", [], {
          load: async () => ({ name: "k", model: "openai/gpt-5", models: { allow: ["deepseek/*"] }, content: "x" }),
        }),
      V,
    )
  })

  test("valid deny-list persona (allowed frontmatter model) DOES resolve", async () => {
    const r = await PersonaSession.resolve("katya", [], {
      load: async () => ({
        name: "katya",
        model: "deepseek/deepseek-chat",
        models: { deny: ["anthropic/*", "openai/*"] },
        content: "x",
      }),
    })
    expect(r?.name).toBe("katya")
    // Policy lives under config.models (SC-4), never a top-level field.
    expect(r?.config.models?.deny).toEqual(["anthropic/*", "openai/*"])
  })
})

// ============================================================================
// V6a — fail-closed on persona load/parse failure (WHAT 10a, SEC-4, CC-8)
// "WHEN a persona ... is explicitly requested ... and the load yields `undefined`,
//  it SHALL throw a clear, named error rather than return `undefined`."
// Control: NO persona requested => no throw, behaves as before.
// ============================================================================
describe("V6a — fail-closed on load failure (WHAT 10a, SEC-4, CC-8)", () => {
  test("explicitly-requested persona whose load yields undefined => throws PolicyLoadError", async () => {
    const err = await expectRejects(
      () => PersonaSession.resolve("katya", [], { load: async () => undefined }),
      "PersonaPolicyLoadError",
    )
    expect(err.data?.persona ?? JSON.stringify(err.data)).toContain("katya")
  })

  test("control: no persona requested (name undefined) does NOT throw and returns undefined", async () => {
    const r = await PersonaSession.resolve(undefined, [], { load: async () => undefined })
    expect(r).toBeUndefined()
  })
})

// ============================================================================
// V7 — executor choke point rejects a denied model via EVERY path, reading the
//      RIGHT field (WHAT 5-8, SEC-1, SC-4).  === THE KATYA INVARIANT ===
//
// resolveEffectiveModel is the choke point run immediately before
// sdk.session.prompt (spec HOW item 4). A throw here == zero prompt calls.
// The ResolvedPersona carries its policy ONLY under `.config.models`; a guard
// that read `resolvedPersona.models` would no-op and the denied model would slip
// through — so every "throws" below also proves the field-path is correct (SC-4).
// ============================================================================
describe("V7 — Katya invariant: denied model NEVER reaches the prompt via ANY path (WHAT 5-8, SEC-1, SC-4)", () => {
  const F = "PersonaModelForbiddenError"

  // deny-list persona (valid frontmatter model present, so a real ResolvedPersona is legal)
  const denyConfig: PersonaConfig = {
    name: "katya",
    model: "deepseek/deepseek-chat",
    models: { deny: ["anthropic/*", "openai/*"] },
    content: "x",
  }

  test("PATH 1 — chat override to anthropic/* => throws before prompt (prompt count == 0)", async () => {
    const d = allowedDefault()
    const err = await expectRejects(
      () =>
        Runner.resolveEffectiveModel(
          resolvedPersona(denyConfig, "deepseek/deepseek-chat"),
          { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
          d.fn,
        ),
      F,
    )
    // Error names the persona + the denied key (ModelForbiddenError schema).
    expect(err.data?.persona).toBe("katya")
    expect(String(err.data?.model)).toContain("anthropic/")
  })

  test("PATH 2 — persona FRONTMATTER model is denied (openai/*) => throws before prompt", async () => {
    // Construct a ResolvedPersona whose frontmatter model is denied. (resolve()
    // would reject this at validation; here we inject it directly to prove the
    // executor guard is a second, independent gate — SEC-1 defense at the choke.)
    const d = allowedDefault()
    await expectRejects(
      () => Runner.resolveEffectiveModel(resolvedPersona(denyConfig, "openai/gpt-5"), undefined, d.fn),
      F,
    )
  })

  test("PATH 3 — default fallback resolves a DENIED model => throws, no silent downgrade (WHAT 6)", async () => {
    // No override, no frontmatter model: the guard must force a concrete default
    // and check it. The default here is denied (today's biased fallback).
    const noModel: PersonaConfig = { name: "katya", models: { deny: ["anthropic/*"] }, content: "x" }
    await expectRejects(
      () => Runner.resolveEffectiveModel(resolvedPersona(noModel, undefined), undefined, deniedDefault),
      F,
    )
  })

  test("PATH 4 — allow-only persona, override OUTSIDE the allow list => throws", async () => {
    const allowOnly: PersonaConfig = {
      name: "katya",
      model: "deepseek/deepseek-chat",
      models: { allow: ["deepseek/*"] },
      content: "x",
    }
    const d = allowedDefault()
    await expectRejects(
      () =>
        Runner.resolveEffectiveModel(
          resolvedPersona(allowOnly, "deepseek/deepseek-chat"),
          { providerID: "openai", modelID: "gpt-5" },
          d.fn,
        ),
      F,
    )
  })

  test("POSITIVE CONTROL — an ALLOWED override passes through (guard is not blanket-throwing)", async () => {
    const d = allowedDefault()
    const eff = await Runner.resolveEffectiveModel(
      resolvedPersona(denyConfig, "deepseek/deepseek-chat"),
      { providerID: "deepseek", modelID: "deepseek-chat" },
      d.fn,
    )
    expect(eff).toEqual({ providerID: "deepseek", modelID: "deepseek-chat" })
  })
})

// ============================================================================
// V8 — non-policy persona is unaffected (WHAT 20)
// "Personas that declare no `models` policy SHALL behave exactly as before (no
//  new failure paths, no forced explicit resolution)."
// ============================================================================
describe("V8 — non-policy persona is byte-identical to pre-change (WHAT 20)", () => {
  const plain: PersonaConfig = { name: "plain", content: "x" }

  test("no override, no frontmatter, no policy => model stays undefined; default is NOT forced", async () => {
    const d = allowedDefault()
    const eff = await Runner.resolveEffectiveModel(resolvedPersona(plain, undefined), undefined, d.fn)
    expect(eff).toBeUndefined()
    expect(d.calls).toBe(0) // no forced Provider.defaultModel resolution for a non-policy persona
  })

  test("a non-policy persona with an override passes it through with no guard rejection", async () => {
    const d = allowedDefault()
    const eff = await Runner.resolveEffectiveModel(
      resolvedPersona(plain, undefined),
      { providerID: "anthropic", modelID: "claude-x" }, // no policy => not forbidden
      d.fn,
    )
    expect(eff).toEqual({ providerID: "anthropic", modelID: "claude-x" })
  })
})

// ============================================================================
// Harness-driven tests (V4, V5, V9). These drive the real Telegram bot through
// the mocked transport. The active persona is the on-disk "katya" fixture
// (deny anthropic/openai, allow/default deepseek).
// ============================================================================
describe("V4 — reject setting a forbidden model; override unchanged (WHAT 13-14, SEC-3)", () => {
  let h: TelegramHarness
  beforeEach(async () => {
    purgeQueue()
    h = new TelegramHarness({ persona: "katya", allowedChatIds: [] })
    await h.start()
    h.setEchoRunner("ok")
  })

  test("(a) /model anthropic/... is rejected; the stored override is never set to the forbidden model", async () => {
    const chat = chatId("v4a")
    expect(TelegramStore.getModel(chat)).toBeUndefined() // no override to start
    h.injectMessage(chat, "/model anthropic/claude-sonnet-4-5")
    await h.tick(30)
    // SEC-3: the forbidden model SHALL NOT become the stored override.
    expect(TelegramStore.getModel(chat)).toBeUndefined()
    await h.stop()
  })

  test("(b) a `model:anthropic/...` inline callback is rejected; override unchanged; error answered", async () => {
    const chat = chatId("v4b")
    const answersBefore = h.answers().length
    h.injectCallback(chat, "model:anthropic/claude-sonnet-4-5")
    await h.waitFor(() => h.answers().length > answersBefore, 5000)
    // SEC-3: forbidden selection is not stored...
    expect(TelegramStore.getModel(chat)).toBeUndefined()
    // ...and the callback is answered (error surfaced to chat).
    expect(h.answers().length).toBeGreaterThan(answersBefore)
    await h.stop()
  })
})

describe("V5 — set an ALLOWED model; subsequent prompts use it (WHAT 15-18)", () => {
  test("allowed inline selection persists and every later prompt carries the override", async () => {
    purgeQueue()
    const h = new TelegramHarness({ persona: "katya", allowedChatIds: [] })
    await h.start()
    await h.startWorker()
    const received: Array<RunModel | undefined> = []
    h.setRunner(async ({ sessionId, onSessionCreated, model }) => {
      received.push(model)
      const sid = sessionId ?? "ses_v5_" + received.length
      if (!sessionId) onSessionCreated?.(sid)
      return { sessionId: sid, response: "ok", toolCalls: 0, durationMs: 1 }
    })
    const chat = chatId("v5")

    // Select an allowed model via inline callback (WHAT 14 re-checks isModelAllowed).
    h.injectCallback(chat, "model:deepseek/deepseek-chat")
    await h.waitFor(() => TelegramStore.getModel(chat) !== undefined, 5000)
    // WHAT 15: durable per-chat override stored.
    expect(TelegramStore.getModel(chat)).toEqual({ providerID: "deepseek", modelID: "deepseek-chat" })

    // WHAT 16-18: two messages in the same durable session both carry the override.
    h.injectMessage(chat, "first")
    h.injectMessage(chat, "second")
    await h.waitFor(() => received.length >= 2, 8000)
    await h.drain()

    expect(received.length).toBeGreaterThanOrEqual(2)
    for (const m of received) {
      expect(m).toEqual({ providerID: "deepseek", modelID: "deepseek-chat" })
    }
    // The choice sticks across turns.
    expect(TelegramStore.getModel(chat)).toEqual({ providerID: "deepseek", modelID: "deepseek-chat" })
    await h.stop()
  })
})

describe("V9 — /status reports session_id, active model, persona (WHAT 19)", () => {
  let h: TelegramHarness
  beforeEach(async () => {
    purgeQueue()
    h = new TelegramHarness({ persona: "katya", allowedChatIds: [] })
    await h.start()
    h.setEchoRunner("ok")
  })

  test("with an override set, /status shows the session id, the override model, and the persona", async () => {
    const chat = chatId("v9a")
    TelegramStore.setSession(chat, "ses_v9_fixed")
    TelegramStore.setModel(chat, "deepseek/deepseek-chat")
    const before = h.sends().length
    h.injectMessage(chat, "/status")
    await h.waitFor(() => h.sends().length > before, 5000)
    const text = h.sends().at(-1)?.body?.text ?? ""
    expect(text).toContain("ses_v9_fixed") // session_id
    expect(text).toContain("deepseek/deepseek-chat") // active model (override)
    expect(text.toLowerCase()).toContain("katya") // persona
    await h.stop()
  })

  test("with NO override, /status reports the persona/default effective model", async () => {
    const chat = chatId("v9b")
    const before = h.sends().length
    h.injectMessage(chat, "/status")
    await h.waitFor(() => h.sends().length > before, 5000)
    const text = h.sends().at(-1)?.body?.text ?? ""
    // The persona frontmatter default is the effective model when no override is set.
    expect(text).toContain("deepseek/deepseek-chat")
    expect(text.toLowerCase()).toContain("katya")
    await h.stop()
  })
})

// ============================================================================
// V3 — /model no-arg keyboard filtering (WHAT 11-12, SEC-3)
// The keyboard FILTER predicate (exclude every model forbidden for the persona)
// is tested directly against the same `isModelAllowed` predicate the command uses.
// The full end-to-end keyboard (sort order, <=8 cap, callback_data shape, reply
// naming the current model) is a documented HARNESS GAP — see the test.todo below.
// ============================================================================
describe("V3 — /model keyboard excludes forbidden families (WHAT 11-12, SEC-3)", () => {
  test("the keyboard filter predicate drops every anthropic/* and openai/* candidate for Katya", () => {
    const policy = { deny: ["anthropic/*", "openai/*"], allow: ["deepseek/*"] }
    // A Provider.list-shaped candidate mix (the command filters these via isModelAllowed).
    const candidates = [
      "anthropic/claude-sonnet-4-5",
      "openai/gpt-5",
      "openai/gpt-5-mini",
      "deepseek/deepseek-chat",
      "deepseek/deepseek-reasoner",
      "google/gemini-3-pro",
    ]
    const allowed = candidates.filter((key) => PersonaPolicy.isModelAllowed(policy, key))
    // SEC-3: no forbidden family may appear in the offered set.
    expect(allowed.some((k) => k.startsWith("anthropic/"))).toBe(false)
    expect(allowed.some((k) => k.startsWith("openai/"))).toBe(false)
    // allow-list keeps deepseek and drops google (not in allow list).
    expect(allowed).toEqual(["deepseek/deepseek-chat", "deepseek/deepseek-reasoner"])
  })

  // GAP: the end-to-end /model keyboard (button set, `Provider.sort` order, <=8
  // cap, `callback_data = model:<provider>/<model>`, and the reply naming the
  // current effective model) cannot be exercised in this harness. `Provider.list`
  // / `Provider.defaultModel` require configured providers in an Instance context;
  // the headless test env (test/preload.ts deletes all provider API keys) has NO
  // configured providers, so `/model` with no argument emits no keyboard at all.
  // The filtering LOGIC is covered above and by V2; the SEC-1 executor guard
  // (which stands even if a forbidden button ever slipped through) is covered by V7.
  test.todo("V3 end-to-end keyboard content/order/cap — needs configured providers (Provider.list empty in headless env)", () => {})
})

// ============================================================================
// Amendment A picker tests (VA1..VA5). All run against the deny-only
// "pickerpersona" fixture (anthropic/openai denied, everything else allowed) so
// the Katya boundary holds while a diverse catalog can be searched/paginated.
// The provider catalog is injected via the TelegramBot.__setModelCatalog test
// seam (test/preload.ts strips provider keys, so real Provider.list is empty in
// the headless env). Keys returned by the stub are already in Provider.sort order.
// ============================================================================

// ============================================================================
// VA1 — no-arg picker shows recent + suggested, all allowed, capped (A1, A5).
// ============================================================================
describe("VA1 — no-arg picker: recent-then-sorted, policy-filtered, capped (Amendment A1, A5)", () => {
  test("recent keys lead (most-recent first), then Provider.sort order, no denied families, <= K", async () => {
    purgeQueue()
    const h = new TelegramHarness({ persona: "pickerpersona", allowedChatIds: [] })
    await h.start()
    h.setEchoRunner("ok")
    const chat = chatId("va1")
    // Sorted catalog (Provider.sort order) with more than K allowed + 2 denied.
    const sorted = [
      "deepseek/a",
      "deepseek/b",
      "deepseek/c",
      "deepseek/d",
      "deepseek/e",
      "deepseek/f",
      "deepseek/g",
      "deepseek/h",
      "deepseek/i",
      "anthropic/claude-x",
      "openai/gpt-5",
    ]
    TelegramBot.__setModelCatalog(async () => ({ keys: sorted, default: "deepseek/deepseek-chat" }))
    // Seed recent, most-recent first.
    TelegramBot.__seedRecent(chat, ["deepseek/f", "deepseek/c"])

    const before = h.keyboardSends().length
    h.injectMessage(chat, "/model")
    await h.waitFor(() => h.keyboardSends().length > before, 5000)

    const buttons = h.lastKeyboard()
    const picks = buttons.filter((b) => b.callback_data.startsWith("model:pick:"))
    // Recent keys lead, most-recent first.
    expect(picks[0]?.text).toBe("deepseek/f")
    expect(picks[1]?.text).toBe("deepseek/c")
    // At most K buttons.
    expect(picks.length).toBeLessThanOrEqual(8)
    // No denied family is ever offered (A5, SEC-3).
    expect(picks.every((b) => !b.text.startsWith("anthropic/") && !b.text.startsWith("openai/"))).toBe(true)
    // Reply names the current effective model and instructs the search form.
    const text = h.keyboardSends().at(-1)?.body?.text ?? ""
    expect(text).toContain("deepseek/deepseek-chat")
    expect(text).toContain("/model <search>")
    await h.stop()
  })
})

// ============================================================================
// VA2 — search filters, paginates, and exact-key set takes precedence (A2, A5).
// ============================================================================
describe("VA2 — search + paginate + exact-key precedence (Amendment A2, A5)", () => {
  test("substring search paginates matches, drops denied, Next yields the rest; exact key still SETS", async () => {
    purgeQueue()
    const h = new TelegramHarness({ persona: "pickerpersona", allowedChatIds: [] })
    await h.start()
    h.setEchoRunner("ok")
    const chat = chatId("va2")
    const llamas = Array.from({ length: 11 }, (_, i) => `deepinfra/llama-${i}`)
    // A denied entry that ALSO matches "llama": must be filtered out by policy.
    const catalog = [...llamas, "deepseek/deepseek-chat", "anthropic/llama-decoy"]
    TelegramBot.__setModelCatalog(async () => ({ keys: catalog, default: "deepseek/deepseek-chat" }))

    // Page 0 of the search.
    let before = h.keyboardSends().length
    h.injectMessage(chat, "/model llama")
    await h.waitFor(() => h.keyboardSends().length > before, 5000)
    let buttons = h.lastKeyboard()
    let picks = buttons.filter((b) => b.callback_data.startsWith("model:pick:"))
    expect(picks.length).toBeLessThanOrEqual(8)
    expect(picks.length).toBeGreaterThan(0)
    // Every match contains "llama" (case-insensitive) and none is a denied family.
    expect(picks.every((b) => b.text.toLowerCase().includes("llama"))).toBe(true)
    expect(picks.every((b) => !b.text.startsWith("anthropic/"))).toBe(true)
    // More than one page => a Next control exists.
    expect(buttons.some((b) => b.callback_data === "model:page:1")).toBe(true)

    // Page 1 yields the remaining matches (11 - 8 = 3).
    before = h.keyboardSends().length
    h.injectCallback(chat, "model:page:1")
    await h.waitFor(() => h.keyboardSends().length > before, 5000)
    buttons = h.lastKeyboard()
    picks = buttons.filter((b) => b.callback_data.startsWith("model:pick:"))
    expect(picks.length).toBe(3)

    // A search with no matches replies "no models found".
    before = h.sends().length
    h.injectMessage(chat, "/model zzzz-nope")
    await h.waitFor(() => h.sends().length > before, 5000)
    expect((h.sends().at(-1)?.body?.text ?? "").toLowerCase()).toContain("no models found")

    // An exact existing allowed key SETS it (requirement 13 precedence, not a search).
    h.injectMessage(chat, "/model deepseek/deepseek-chat")
    await h.waitFor(() => TelegramStore.getModel(chat) !== undefined, 5000)
    expect(TelegramStore.getModel(chat)).toEqual({ providerID: "deepseek", modelID: "deepseek-chat" })
    await h.stop()
  })
})

// ============================================================================
// VA3 — a >64-byte key is selectable via a short token, NOT raw callback_data (A3).
// ============================================================================
describe("VA3 — long key selects via short token; every callback_data <= 64 bytes (Amendment A3)", () => {
  test("keyboard callback_data stays within 64 bytes and the tapped token resolves the long key", async () => {
    purgeQueue()
    const h = new TelegramHarness({ persona: "pickerpersona", allowedChatIds: [] })
    await h.start()
    h.setEchoRunner("ok")
    const chat = chatId("va3")
    const longId = "super-long-model-identifier-that-definitely-exceeds-sixty-four-bytes-in-total-length"
    const longKey = `deepinfra/${longId}`
    // Precondition: the underlying key really is longer than Telegram's limit.
    expect(Buffer.byteLength(longKey, "utf8")).toBeGreaterThan(64)
    TelegramBot.__setModelCatalog(async () => ({ keys: [longKey, "deepseek/deepseek-chat"], default: "deepseek/deepseek-chat" }))

    const before = h.keyboardSends().length
    h.injectMessage(chat, "/model")
    await h.waitFor(() => h.keyboardSends().length > before, 5000)
    const buttons = h.lastKeyboard()

    // A3 hard requirement: EVERY button's callback_data is <= 64 bytes.
    for (const b of buttons) {
      expect(Buffer.byteLength(b.callback_data, "utf8")).toBeLessThanOrEqual(64)
    }
    // The long key is offered as a button whose callback_data is a short pick token.
    const longBtn = buttons.find((b) => b.text === longKey)
    expect(longBtn).toBeDefined()
    expect(longBtn!.callback_data.startsWith("model:pick:")).toBe(true)

    // Tapping the token resolves to the concrete long key and sets it.
    h.injectCallback(chat, longBtn!.callback_data)
    await h.waitFor(() => TelegramStore.getModel(chat) !== undefined, 5000)
    expect(TelegramStore.getModel(chat)).toEqual({ providerID: "deepinfra", modelID: longId })
    await h.stop()
  })
})

// ============================================================================
// VA4 — stale/expired token and a forbidden resolved model are both safe (A4, A5).
// ============================================================================
describe("VA4 — stale token + forbidden token safety (Amendment A4, A5)", () => {
  test("(a) a pick token with NO picker state changes nothing and asks to re-run /model (no throw)", async () => {
    purgeQueue()
    const h = new TelegramHarness({ persona: "pickerpersona", allowedChatIds: [] })
    await h.start()
    h.setEchoRunner("ok")
    const chat = chatId("va4a")
    const before = h.sends().length
    h.injectCallback(chat, "model:pick:0") // no picker state seeded => stale
    await h.waitFor(() => h.sends().length > before, 5000)
    expect(TelegramStore.getModel(chat)).toBeUndefined()
    expect((h.sends().at(-1)?.body?.text ?? "").toLowerCase()).toContain("re-run")
    await h.stop()
  })

  test("(b) a token resolving to a DENIED model is re-checked and rejected; override unchanged", async () => {
    purgeQueue()
    const h = new TelegramHarness({ persona: "pickerpersona", allowedChatIds: [] })
    await h.start()
    h.setEchoRunner("ok")
    const chat = chatId("va4b")
    // Seed picker state with a denied candidate directly (A5 keeps it out of the
    // real picker; this proves the A4 selection-time re-check is a real second gate).
    TelegramBot.__seedPicker(chat, { term: "", page: 0, candidates: ["anthropic/claude-sonnet-4-5"] })
    const before = h.sends().length
    h.injectCallback(chat, "model:pick:0")
    await h.waitFor(() => h.sends().length > before, 5000)
    expect(TelegramStore.getModel(chat)).toBeUndefined()
    expect((h.sends().at(-1)?.body?.text ?? "").toLowerCase()).toContain("not allowed")
    await h.stop()
  })
})

// ============================================================================
// VA5 — a successful set records the model in the chat's recent list (A6).
// ============================================================================
describe("VA5 — successful set records recent, surfaced first in the no-arg picker (Amendment A6)", () => {
  test("setting via search selection puts the model first in the next no-arg keyboard", async () => {
    purgeQueue()
    const h = new TelegramHarness({ persona: "pickerpersona", allowedChatIds: [] })
    await h.start()
    h.setEchoRunner("ok")
    const chat = chatId("va5")
    const keys = ["deepinfra/llama-a", "deepinfra/llama-b", "deepseek/deepseek-chat"]
    TelegramBot.__setModelCatalog(async () => ({ keys, default: "deepseek/deepseek-chat" }))

    // Search then select llama-b.
    let before = h.keyboardSends().length
    h.injectMessage(chat, "/model llama-b")
    await h.waitFor(() => h.keyboardSends().length > before, 5000)
    const btn = h.lastKeyboard().find((b) => b.text === "deepinfra/llama-b")
    expect(btn).toBeDefined()
    h.injectCallback(chat, btn!.callback_data)
    await h.waitFor(() => TelegramStore.getModel(chat) !== undefined, 5000)
    expect(TelegramStore.getModel(chat)).toEqual({ providerID: "deepinfra", modelID: "llama-b" })

    // The no-arg picker now leads with the just-set model.
    before = h.keyboardSends().length
    h.injectMessage(chat, "/model")
    await h.waitFor(() => h.keyboardSends().length > before, 5000)
    const picks = h.lastKeyboard().filter((b) => b.callback_data.startsWith("model:pick:"))
    expect(picks[0]?.text).toBe("deepinfra/llama-b")
    await h.stop()
  })
})

// ============================================================================
// V10 — build/regression (CC-9, WHAT 20)
// Typecheck + full package suite are run as the repo-level gate (`make sdd`), not
// from a single test file. This file's own suite passing is the local check.
// ============================================================================
describe("V10 — build/regression (CC-9, WHAT 20)", () => {
  test.todo("full-suite `bun test` + `tsc --noEmit` are the repo-level gate, run outside this file", () => {})
})
