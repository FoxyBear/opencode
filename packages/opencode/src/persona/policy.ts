import z from "zod"
import { NamedError } from "@opencode-ai/util/error"
import type { PersonaConfig } from "./index"

// SDD-02 (SEC-1..SEC-4, SC-4): the Katya security invariant lives here. This
// module is pure and dependency-free (no Provider, no Effect) so it is cheap to
// import on the hot path (the executor choke point) and trivial to unit-test.
export namespace PersonaPolicy {
  export interface ModelPolicy {
    allow?: string[]
    deny?: string[]
  }

  // A denied model reaching the executor is a hard failure, never a downgrade.
  export const ModelForbiddenError = NamedError.create(
    "PersonaModelForbiddenError",
    z.object({
      persona: z.string(),
      model: z.string(),
    }),
  )

  // SEC-2: a persona that declares a policy but whose default `model` is missing
  // or forbidden fails loudly at resolution time.
  export const PolicyValidationError = NamedError.create(
    "PersonaPolicyValidationError",
    z.object({
      persona: z.string(),
      reason: z.string(),
    }),
  )

  // SEC-4 / CC-8: an explicitly requested persona whose file fails to load or
  // parse fails closed (deny) rather than falling through to an unconstrained
  // default that could be a forbidden provider.
  export const PolicyLoadError = NamedError.create(
    "PersonaPolicyLoadError",
    z.object({
      persona: z.string(),
    }),
  )

  /**
   * Anchored glob match over a `providerID/modelID` key. The only wildcard is
   * `*` (trailing or a bare `*`), which becomes `.*` after the rest of the glob
   * is regex-escaped. No dependency is introduced (WHAT 2).
   */
  export function matchesGlob(modelKey: string, glob: string): boolean {
    const pattern = glob.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*")
    return new RegExp(`^${pattern}$`).test(modelKey)
  }

  /**
   * deny-wins, then allowlist semantics (WHAT 3-4):
   * - a model matching any `deny` glob is forbidden even if it also matches `allow`.
   * - WHEN `allow` is present, a model matching no `allow` glob is forbidden.
   * - WHEN `allow` is absent, every model not matching `deny` is allowed.
   * - no policy at all = allowed.
   */
  export function isModelAllowed(policy: ModelPolicy | undefined, modelKey: string): boolean {
    if (!policy) return true
    if (policy.deny?.some((g) => matchesGlob(modelKey, g))) return false
    // `allow` present (even empty) acts as an allowlist: unmatched = forbidden.
    if (policy.allow !== undefined) return policy.allow.some((g) => matchesGlob(modelKey, g))
    return true
  }

  /** WHEN a persona declares `allow` or `deny`, it declares a policy. */
  export function hasPolicy(policy: ModelPolicy | undefined): boolean {
    return !!policy && (policy.allow !== undefined || policy.deny !== undefined)
  }

  /**
   * SEC-1 choke-point assertion. NORMATIVE (SC-4): the policy is read from
   * `config.models`, the REAL field. The caller passes the `PersonaConfig` (which
   * carries both `name` and `models`), NEVER a `ResolvedPersona` (which has no
   * top-level `models`, so passing it would read `undefined` and silently
   * no-op). Throws `ModelForbiddenError` when the model is denied.
   */
  export function assertModelAllowed(config: PersonaConfig, model: { providerID: string; modelID: string }): void {
    const key = `${model.providerID}/${model.modelID}`
    if (!isModelAllowed(config.models, key)) {
      throw new ModelForbiddenError({ persona: config.name, model: key })
    }
  }

  /**
   * SEC-2 (WHAT 9, SC-4): WHEN `config.models` declares ANY policy, require an
   * explicit frontmatter `model` that is itself allowed under the policy. Covers
   * allow-only personas: an `allow` list with no default model, or a default
   * model outside the list, fails exactly like a `deny`-declaring persona.
   */
  export function validateModelPolicy(config: PersonaConfig): void {
    const policy = config.models
    if (!hasPolicy(policy)) return
    if (!config.model) {
      throw new PolicyValidationError({
        persona: config.name,
        reason: "declares a models policy but no default `model`",
      })
    }
    if (!isModelAllowed(policy, config.model)) {
      throw new PolicyValidationError({
        persona: config.name,
        reason: `default model "${config.model}" is forbidden by the persona's own models policy`,
      })
    }
  }
}
