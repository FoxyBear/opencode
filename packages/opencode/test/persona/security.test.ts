import { describe, expect, test } from "bun:test"
import { PersonaPolicy } from "../../src/persona/policy"
import { PersonaSession } from "../../src/persona/session"
import { Runner } from "../../src/daemon/runner"
import type { PersonaConfig } from "../../src/persona/index"

// SDD-02 SEC-1..SEC-4 / master SC-4: Katya must never resolve to an
// Anthropic/OpenAI model via ANY path. These tests exercise the security core
// deterministically: the policy helpers, the SEC-2 validation, the fail-closed
// load, and the SEC-1 executor guard seam (Runner.resolveEffectiveModel, which
// the executor calls BEFORE sdk.session.prompt — a throw there means the prompt
// is never sent).

const KATYA_DENY: PersonaConfig = {
  name: "katya",
  model: "deepseek/deepseek-chat",
  models: { deny: ["anthropic/*", "openai/*"] },
  content: "katya",
}

function resolved(config: PersonaConfig): PersonaSession.ResolvedPersona {
  return { name: config.name, config, systemPrompt: config.content, model: config.model }
}

describe("PersonaPolicy.matchesGlob (WHAT 2)", () => {
  test("trailing wildcard matches provider family", () => {
    expect(PersonaPolicy.matchesGlob("anthropic/claude-sonnet-4-5", "anthropic/*")).toBe(true)
    expect(PersonaPolicy.matchesGlob("openai/gpt-5-nano", "openai/gpt-5*")).toBe(true)
    expect(PersonaPolicy.matchesGlob("deepseek/deepseek-chat", "anthropic/*")).toBe(false)
  })

  test("bare * matches everything and is anchored", () => {
    expect(PersonaPolicy.matchesGlob("anything/at-all", "*")).toBe(true)
    // Anchored: a glob prefix must match the whole key, not a substring.
    expect(PersonaPolicy.matchesGlob("notanthropic/x", "anthropic/*")).toBe(false)
  })
})

describe("PersonaPolicy.isModelAllowed (WHAT 3-4)", () => {
  const policy: PersonaPolicy.ModelPolicy = { deny: ["anthropic/*"], allow: ["deepseek/*"] }

  test("deny-wins then allowlist", () => {
    expect(PersonaPolicy.isModelAllowed(policy, "deepseek/deepseek-chat")).toBe(true)
    expect(PersonaPolicy.isModelAllowed(policy, "anthropic/claude-sonnet-4-5")).toBe(false) // deny
    expect(PersonaPolicy.isModelAllowed(policy, "openai/gpt-5")).toBe(false) // not in allow
  })

  test("deny-only allows anything not denied", () => {
    expect(PersonaPolicy.isModelAllowed({ deny: ["anthropic/*"] }, "openai/gpt-5")).toBe(true)
    expect(PersonaPolicy.isModelAllowed({ deny: ["anthropic/*"] }, "anthropic/claude-x")).toBe(false)
  })

  test("deny wins over a matching allow", () => {
    expect(PersonaPolicy.isModelAllowed({ allow: ["*"], deny: ["anthropic/*"] }, "anthropic/claude-x")).toBe(false)
  })

  test("no policy allows all", () => {
    expect(PersonaPolicy.isModelAllowed(undefined, "anthropic/claude-x")).toBe(true)
  })
})

// (a) A denied model offered/typed via /model is rejected — this is the exact
// gate /model (and its callback) apply before persisting an override.
describe("Katya /model gate (SC-4 case a)", () => {
  test("anthropic and openai are rejected, deepseek accepted", () => {
    const p = KATYA_DENY.models
    expect(PersonaPolicy.isModelAllowed(p, "anthropic/claude-sonnet-4-5")).toBe(false)
    expect(PersonaPolicy.isModelAllowed(p, "openai/gpt-5")).toBe(false)
    expect(PersonaPolicy.isModelAllowed(p, "deepseek/deepseek-chat")).toBe(true)
  })
})

describe("PersonaSession.resolve validation (SEC-2, SC-4)", () => {
  // (c) deny-list but no allowed default -> fails validation
  test("deny-list persona with no default model throws", async () => {
    const config: PersonaConfig = { name: "katya", models: { deny: ["anthropic/*", "openai/*"] }, content: "k" }
    await expect(PersonaSession.resolve("katya", [], { load: async () => config })).rejects.toThrow(PersonaPolicy.PolicyValidationError)
  })

  test("default model that violates its own deny throws", async () => {
    const config: PersonaConfig = {
      name: "katya",
      model: "anthropic/claude-sonnet-4-5",
      models: { deny: ["anthropic/*"] },
      content: "k",
    }
    await expect(PersonaSession.resolve("katya", [], { load: async () => config })).rejects.toThrow(PersonaPolicy.PolicyValidationError)
  })

  // (d) allow-only persona whose default is outside the allow list -> fails
  test("allow-only persona with no default model throws", async () => {
    const config: PersonaConfig = { name: "katya", models: { allow: ["deepseek/*"] }, content: "k" }
    await expect(PersonaSession.resolve("katya", [], { load: async () => config })).rejects.toThrow(PersonaPolicy.PolicyValidationError)
  })

  test("allow-only persona with default outside the allow list throws", async () => {
    const config: PersonaConfig = {
      name: "katya",
      model: "openai/gpt-5",
      models: { allow: ["deepseek/*"] },
      content: "k",
    }
    await expect(PersonaSession.resolve("katya", [], { load: async () => config })).rejects.toThrow(PersonaPolicy.PolicyValidationError)
  })

  test("valid policy + allowed default resolves", async () => {
    const r = await PersonaSession.resolve("katya", [], { load: async () => KATYA_DENY })
    expect(r?.name).toBe("katya")
    expect(r?.model).toBe("deepseek/deepseek-chat")
  })
})

describe("PersonaSession.resolve fail-closed (SC-4 case e, WHAT 10a)", () => {
  test("explicitly requested persona that fails to load throws PolicyLoadError", async () => {
    await expect(PersonaSession.resolve("katya", [], { load: async () => undefined })).rejects.toThrow(
      PersonaPolicy.PolicyLoadError,
    )
  })

  test("no persona requested is unaffected (returns undefined, no throw)", async () => {
    const r = await PersonaSession.resolve(undefined, [], { load: async () => undefined })
    expect(r).toBeUndefined()
  })
})

describe("Runner.resolveEffectiveModel SEC-1 guard (SC-4 cases b, field-correctness)", () => {
  const denied = { providerID: "anthropic", modelID: "claude-sonnet-4-5" }
  const allowed = { providerID: "deepseek", modelID: "deepseek-chat" }

  // (b) denied model via the default fallback path is rejected at the guard;
  // the guard throws so sdk.session.prompt is never reached.
  test("denied default fallback throws before returning a model", async () => {
    const persona = resolved({ name: "katya", model: undefined, models: { deny: ["anthropic/*"] }, content: "k" } as PersonaConfig)
    let defaultCalls = 0
    await expect(
      Runner.resolveEffectiveModel(persona, undefined, async () => {
        defaultCalls++
        return denied
      }),
    ).rejects.toThrow(PersonaPolicy.ModelForbiddenError)
    expect(defaultCalls).toBe(1) // fallback was resolved concretely, then rejected
  })

  // Field-correctness: policy lives ONLY under config.models. Drive a denied
  // model through EACH path; every path must throw. Were the guard reading a
  // non-existent resolvedPersona.models, the policy would be undefined, nothing
  // would throw, and the denied model would be returned (and later sent).
  test("denied via chat override throws", async () => {
    const persona = resolved(KATYA_DENY)
    await expect(
      Runner.resolveEffectiveModel(persona, denied, async () => allowed),
    ).rejects.toThrow(PersonaPolicy.ModelForbiddenError)
  })

  test("denied via persona frontmatter model throws", async () => {
    const persona = resolved({ name: "katya", model: "anthropic/claude-x", models: { deny: ["anthropic/*"] }, content: "k" } as PersonaConfig)
    await expect(
      Runner.resolveEffectiveModel(persona, undefined, async () => allowed),
    ).rejects.toThrow(PersonaPolicy.ModelForbiddenError)
  })

  test("allow-only persona: denied via each path throws", async () => {
    const persona = resolved({
      name: "katya",
      model: "deepseek/deepseek-chat",
      models: { allow: ["deepseek/*"] },
      content: "k",
    } as PersonaConfig)
    // override outside allow
    await expect(
      Runner.resolveEffectiveModel(persona, { providerID: "openai", modelID: "gpt-5" }, async () => allowed),
    ).rejects.toThrow(PersonaPolicy.ModelForbiddenError)
    // default fallback outside allow
    const noModel = resolved({ name: "katya", models: { allow: ["deepseek/*"] }, content: "k" } as PersonaConfig)
    await expect(
      Runner.resolveEffectiveModel(noModel, undefined, async () => ({ providerID: "openai", modelID: "gpt-5" })),
    ).rejects.toThrow(PersonaPolicy.ModelForbiddenError)
  })

  test("allowed override passes through", async () => {
    const persona = resolved(KATYA_DENY)
    const eff = await Runner.resolveEffectiveModel(persona, allowed, async () => {
      throw new Error("default should not be resolved when an override is present")
    })
    expect(eff).toEqual(allowed)
  })

  // (V8) non-policy persona: byte-identical to before — no forced default
  // resolution, no guard, model stays undefined when none is supplied.
  test("non-policy persona does not force a default and passes undefined through", async () => {
    const persona = resolved({ name: "plain", content: "p" } as PersonaConfig)
    let defaultCalls = 0
    const eff = await Runner.resolveEffectiveModel(persona, undefined, async () => {
      defaultCalls++
      return denied
    })
    expect(eff).toBeUndefined()
    expect(defaultCalls).toBe(0)
  })
})
