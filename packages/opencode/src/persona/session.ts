import { Persona, type PersonaConfig } from "./index"
import { PersonaPolicy } from "./policy"
import type { SessionID } from "../session/schema"
import { Log } from "../util/log"

const log = Log.create({ service: "persona.session" })

export namespace PersonaSession {
  export interface ResolvedPersona {
    readonly name: string
    readonly config: PersonaConfig
    readonly systemPrompt: string
    readonly model?: string
  }

  const _bySession = new Map<string, ResolvedPersona>()

  let _defaultName: string | undefined = undefined
  let _default: ResolvedPersona | undefined = undefined

  export interface ResolveOptions {
    load?: (name: string) => Promise<PersonaConfig | undefined>
  }

  export async function resolve(
    name: string | undefined,
    configuredMcpServers: string[],
    opts: ResolveOptions = {},
  ): Promise<ResolvedPersona | undefined> {
    if (!name) return undefined

    const loader = opts.load ?? Persona.resolve
    const config = await loader(name)
    if (!config) {
      // SDD-02 SC-4 / WHAT 10a: a persona was explicitly requested (non-empty
      // `name`) but its file is missing/renamed or its frontmatter failed to
      // parse (both swallowed to `undefined` upstream). Fail CLOSED: throw a
      // named error rather than return `undefined` and let the executor fall
      // through to an unconstrained default that could be a forbidden provider.
      // The security boundary is tied to load success, not best-effort parse.
      // Only the genuine "no persona requested" case (handled by the early
      // return above) is unaffected.
      log.warn("persona failed to load, failing closed", { name })
      throw new PersonaPolicy.PolicyLoadError({ persona: name })
    }

    const missing = Persona.checkToolRequirements(config, configuredMcpServers)
    if (missing.length > 0) {
      throw new Error(
        `Persona "${name}" requires missing MCP servers: ${missing.join(", ")}`,
      )
    }

    const systemPrompt = Persona.buildSystemPrompt(config)

    // SEC-2 (WHAT 9): a persona declaring any models policy must also declare an
    // allowed default `model`. Let it throw, like the missing-MCP throw above.
    PersonaPolicy.validateModelPolicy(config)

    return {
      name,
      config,
      systemPrompt,
      model: config.model,
    }
  }

  export function attach(sessionID: SessionID, resolved: ResolvedPersona): void {
    _bySession.set(sessionID as unknown as string, resolved)
  }

  export function get(sessionID: SessionID): ResolvedPersona | undefined {
    return _bySession.get(sessionID as unknown as string)
  }

  export function clear(sessionID: SessionID): void {
    _bySession.delete(sessionID as unknown as string)
  }

  export async function setDefault(
    name: string,
    configuredMcpServers: string[],
    opts: ResolveOptions = {},
  ): Promise<ResolvedPersona | undefined> {
    if (!name) return undefined
    if (_defaultName === name && _default) return _default
    try {
      const resolved = await resolve(name, configuredMcpServers, opts)
      _defaultName = name
      _default = resolved
      return resolved
    } catch (err) {
      log.warn("setDefault failed, continuing without default persona", {
        name,
        error: err instanceof Error ? err.message : String(err),
      })
      _defaultName = name
      _default = undefined
      return undefined
    }
  }

  export function getDefault(): ResolvedPersona | undefined {
    return _default
  }

  export function _resetAll(): void {
    _bySession.clear()
    _defaultName = undefined
    _default = undefined
  }
}
