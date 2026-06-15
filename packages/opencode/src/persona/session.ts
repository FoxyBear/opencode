import { Persona, type PersonaConfig } from "./index"
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
      log.warn("persona not found, continuing without persona", { name })
      return undefined
    }

    const missing = Persona.checkToolRequirements(config, configuredMcpServers)
    if (missing.length > 0) {
      throw new Error(
        `Persona "${name}" requires missing MCP servers: ${missing.join(", ")}`,
      )
    }

    return {
      name,
      config,
      systemPrompt: Persona.buildSystemPrompt(config),
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
