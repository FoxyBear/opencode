import path from "path"
import fs from "fs/promises"
import matter from "gray-matter"
import { Global } from "../global"
import { ConfigPaths } from "../config/paths"
import { Instance } from "../project/instance"
import { Log } from "../util/log"

const log = Log.create({ service: "persona" })

export interface PersonaConfig {
  readonly name: string
  readonly model?: string
  readonly tools?: {
    require?: string[]
    prefer?: string[]
  }
  // SDD-02 SC-4: the allow/deny model policy lives in persona frontmatter, so the
  // security boundary is a property of the persona identity. Globs are
  // `providerID/modelID` strings (e.g. `anthropic/*`, `openai/gpt-5*`, `*`).
  // WHEN the frontmatter omits `models`, this is `undefined` and behavior is
  // unchanged (no policy = allow all).
  readonly models?: {
    allow?: string[]
    deny?: string[]
  }
  readonly content: string
}

export namespace Persona {
  const PERSONAS_DIR = "personas"

  export async function load(name: string): Promise<PersonaConfig> {
    const dirs = await getPersonaDirs()
    for (const dir of dirs) {
      const filePath = path.join(dir, `${name}.md`)
      try {
        const content = await fs.readFile(filePath, "utf-8")
        return parsePersonaFile(name, content)
      } catch {
        // File not found in this dir, try next
      }
    }
    throw new Error(`Persona not found: "${name}"`)
  }

  export async function list(): Promise<string[]> {
    const dirs = await getPersonaDirs()
    const names = new Set<string>()

    for (const dir of dirs) {
      try {
        const entries = await fs.readdir(dir)
        for (const entry of entries) {
          if (entry.endsWith(".md")) {
            names.add(entry.replace(/\.md$/, ""))
          }
        }
      } catch {
        // Dir doesn't exist, skip
      }
    }

    return [...names].sort()
  }

  export async function resolve(personaName?: string): Promise<PersonaConfig | undefined> {
    if (personaName) {
      try {
        return await load(personaName)
      } catch (err) {
        log.warn("persona resolution failed", { name: personaName, error: String(err) })
        return undefined
      }
    }
    return undefined
  }

  export function checkToolRequirements(
    persona: PersonaConfig,
    configuredMcpServers: string[],
  ): string[] {
    if (!persona.tools?.require) return []
    const configured = new Set(configuredMcpServers)
    return persona.tools.require.filter((name) => !configured.has(name))
  }

  export function formatToolPreferences(persona: PersonaConfig): string | null {
    if (!persona.tools?.prefer || persona.tools.prefer.length === 0) return null
    return `You have access to these tools and should use them proactively: ${persona.tools.prefer.join(", ")}`
  }

  export function buildSystemPrompt(persona: PersonaConfig): string {
    const parts = [persona.content]
    const toolHint = formatToolPreferences(persona)
    if (toolHint) parts.push(toolHint)
    return parts.join("\n\n")
  }

  async function getPersonaDirs(): Promise<string[]> {
    const dirs: string[] = []

    dirs.push(path.join(Global.Path.config, PERSONAS_DIR))

    try {
      const ctx = Instance.current
      if (ctx) {
        const configDirs = await ConfigPaths.directories(ctx.directory, ctx.worktree)
        for (const dir of configDirs) {
          dirs.push(path.join(dir, PERSONAS_DIR))
        }
      }
    } catch {
      // No instance context (e.g., daemon mode)
    }

    return dirs
  }

  function parsePersonaFile(name: string, raw: string): PersonaConfig {
    try {
      const parsed = matter(raw)
      const data = parsed.data as Record<string, any>
      return {
        name: data.name ?? name,
        model: data.model,
        tools: data.tools
          ? {
              require: Array.isArray(data.tools.require) ? data.tools.require : undefined,
              prefer: Array.isArray(data.tools.prefer) ? data.tools.prefer : undefined,
            }
          : undefined,
        // SDD-02 SC-4: coerce allow/deny to `string[] | undefined`, mirroring the
        // tools.require/prefer array-guarding above.
        models: data.models
          ? {
              allow: Array.isArray(data.models.allow) ? data.models.allow : undefined,
              deny: Array.isArray(data.models.deny) ? data.models.deny : undefined,
            }
          : undefined,
        content: parsed.content.trim(),
      }
    } catch {
      return { name, content: raw.trim() }
    }
  }
}
