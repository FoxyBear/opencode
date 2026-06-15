import { Log } from "../util/log"

const log = Log.create({ service: "harness.commands" })

export interface CommandResult {
  text: string
  data?: Record<string, unknown>
}

export interface HarnessCommand {
  name: string
  aliases?: string[]
  description: string
  category: "Mesh" | "Memory" | "Scheduler" | "System" | "AI"
  args?: string
  execute: (args: string) => Promise<CommandResult>
}

interface Transport {
  url: string
  fetch: typeof fetch
}

let _transport: Transport | undefined

async function api(path: string, body?: unknown): Promise<Response> {
  const t = _transport
  if (!t) throw new Error("Harness commands not connected to server")
  const url = `${t.url}${path}`
  const res = body !== undefined
    ? await t.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    : await t.fetch(url)
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    let detail = ""
    try { detail = JSON.parse(text)?.data?.message ?? text } catch { detail = text }
    throw new Error(`${path} returned ${res.status}: ${detail.slice(0, 200)}`)
  }
  return res
}

const commands: HarnessCommand[] = [
  {
    name: "status",
    description: "Daemon health and uptime",
    category: "System",
    async execute() {
      const res = await api("/health")
      const data = await res.json() as any
      if (!data.status) return { text: "Daemon not reachable." }
      const lines = [`Daemon uptime: ${data.uptime_seconds}s`]
      for (const [name, healthy] of Object.entries(data.subsystems ?? {})) {
        lines.push(`  ${name}: ${healthy ? "OK" : "DEGRADED"}`)
      }
      return { text: lines.join("\n"), data }
    },
  },
  {
    name: "peers",
    description: "List mesh peers",
    category: "Mesh",
    async execute() {
      const res = await api("/status")
      const data = await res.json() as any
      if (!data.peers || data.peers.length === 0) return { text: "No mesh peers connected." }
      const lines = data.peers.map(
        (p: any) => `${p.name} (${p.status})`,
      )
      return { text: lines.join("\n"), data: { peers: data.peers, count: data.peers.length } }
    },
  },
  {
    name: "query",
    aliases: ["ask"],
    description: "Delegate prompt to mesh peer",
    category: "Mesh",
    args: "<peer> <prompt>",
    async execute(args) {
      const spaceIdx = args.indexOf(" ")
      if (spaceIdx <= 0) return { text: "Usage: /query <peer> <prompt>" }
      const to = args.slice(0, spaceIdx).trim()
      const prompt = args.slice(spaceIdx + 1).trim()
      if (!prompt) return { text: "Usage: /query <peer> <prompt>" }
      const res = await api("/mesh/query", { to, prompt })
      const result = await res.json() as any
      if (result.status === "error") return { text: `Peer error: ${result.error ?? "unknown"}` }
      return { text: result.response ?? "(empty response)", data: { sessionId: result.sessionId } }
    },
  },
  {
    name: "recall",
    description: "Search persistent memory",
    category: "Memory",
    args: "<query>",
    async execute(args) {
      if (!args.trim()) return { text: "Usage: /recall <query>" }
      try {
        const res = await api("/memory/list", { persona: "default", limit: 100 })
        const entries = await res.json()
        if (!Array.isArray(entries)) throw new Error("Unexpected response from memory backend")
        if (entries.length === 0) return { text: "No memories to search." }
        const query = args.trim().toLowerCase()
        const matches = entries
          .filter((e: any) => e.content?.toLowerCase().includes(query))
          .slice(0, 10)
        if (matches.length === 0) return { text: "No matching memories found." }
        const lines = matches.map(
          (r: any, i: number) => `${i + 1}. ${r.content.slice(0, 200)}`,
        )
        return { text: lines.join("\n\n"), data: { results: matches, count: matches.length } }
      } catch (err) {
        return { text: `Memory recall failed: ${err instanceof Error ? err.message : String(err)}` }
      }
    },
  },
  {
    name: "memories",
    description: "List recent memories",
    category: "Memory",
    async execute() {
      try {
        const res = await api("/memory/list", { persona: "default", limit: 20 })
        const entries = await res.json()
        if (!Array.isArray(entries)) throw new Error("Unexpected response from memory backend")
        if (entries.length === 0) return { text: "No memories stored." }
        const lines = entries.map(
          (e: any, i: number) => `${i + 1}. [${e.id ?? "?"}] ${(e.content ?? "").slice(0, 120)}${(e.content ?? "").length > 120 ? "..." : ""}`,
        )
        return { text: lines.join("\n"), data: { entries, count: entries.length } }
      } catch (err) {
        return { text: `Memory list failed: ${err instanceof Error ? err.message : String(err)}` }
      }
    },
  },
  {
    name: "forget",
    description: "Delete a memory by ID",
    category: "Memory",
    args: "<id>",
    async execute(args) {
      if (!args.trim()) return { text: "Usage: /forget <id>" }
      try {
        const res = await api("/memory/forget", { id: args.trim() })
        const result = await res.json() as any
        if (result.error) return { text: `Forget failed: ${result.error}` }
        return { text: `Forgotten: ${args.trim()}` }
      } catch (err) {
        return { text: `Forget failed: ${err instanceof Error ? err.message : String(err)}` }
      }
    },
  },
  {
    name: "schedule",
    description: "List scheduled tasks",
    category: "Scheduler",
    async execute() {
      try {
        const res = await api("/health")
        const data = await res.json() as any
        return { text: `Active sessions: ${data.active_sessions ?? 0}, Queued tasks: ${data.queued_tasks ?? 0}` }
      } catch (err) {
        return { text: `Scheduler query failed: ${err instanceof Error ? err.message : String(err)}` }
      }
    },
  },
]

export namespace HarnessCommands {
  export function connect(transport: Transport) {
    _transport = transport
  }

  export function all(): readonly HarnessCommand[] {
    return commands
  }

  export function find(name: string): HarnessCommand | undefined {
    return commands.find((c) => c.name === name || c.aliases?.includes(name))
  }

  export function helpText(): string {
    const grouped: Record<string, HarnessCommand[]> = {}
    for (const cmd of commands) {
      ;(grouped[cmd.category] ??= []).push(cmd)
    }
    const lines: string[] = ["Available commands:"]
    for (const [category, cmds] of Object.entries(grouped)) {
      lines.push(`\n${category}:`)
      for (const cmd of cmds) {
        const argHint = cmd.args ? ` ${cmd.args}` : ""
        const aliases = cmd.aliases?.length ? ` (${cmd.aliases.map((a) => "/" + a).join(", ")})` : ""
        lines.push(`  /${cmd.name}${argHint} — ${cmd.description}${aliases}`)
      }
    }
    return lines.join("\n")
  }

  export async function execute(name: string, args: string): Promise<CommandResult | null> {
    const cmd = find(name)
    if (!cmd) return null
    try {
      return await cmd.execute(args)
    } catch (err) {
      log.error("harness command failed", { command: name, error: String(err) })
      return { text: `Error: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
}
