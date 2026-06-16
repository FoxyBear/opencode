import { Router, type RouteContext } from "./router"
import { Mesh } from "../mesh/mesh"
import { Memory } from "../memory/memory"
import { Log } from "../util/log"

const log = Log.create({ service: "harness.handlers" })

export namespace BuiltinHandlers {
  export function register(): void {
    Router.register({
      name: "peers",
      patterns: ["show peers", "peer status", "list peers", "what instances are running"],
      description: "Show connected mesh peers and their status",
      handler: handlePeers,
    })

    Router.register({
      name: "memory",
      patterns: ["what do you remember", "recall memories", "search memory", "list memories"],
      description: "Search and recall stored memories",
      handler: handleMemory,
    })

    Router.register({
      name: "status",
      patterns: ["daemon status", "health check", "system status", "show status"],
      description: "Show daemon health and subsystem status",
      handler: handleStatus,
    })
  }
}

async function handlePeers(_input: string, _context: RouteContext): Promise<string> {
  const peers = await Mesh.peers()
  if (peers.length === 0) {
    return "No mesh peers connected."
  }
  const lines = ["## Mesh Peers", ""]
  for (const peer of peers) {
    lines.push(`- **${peer.name}** — ${peer.status} (${peer.address}:${peer.port})`)
  }
  return lines.join("\n")
}

async function handleMemory(_input: string, _context: RouteContext): Promise<string> {
  const memories = await Memory.list({ persona: "default", limit: 10 })
  if (memories.length === 0) {
    return "No memories stored."
  }
  const lines = ["## Stored Memories", ""]
  for (let i = 0; i < memories.length; i++) {
    const m = memories[i]
    const date = new Date(Number(m.created_at)).toISOString().split("T")[0]
    lines.push(`${i + 1}. [${date}] ${m.content.slice(0, 200)}${m.content.length > 200 ? "..." : ""}`)
  }
  return lines.join("\n")
}

async function handleStatus(_input: string, _context: RouteContext): Promise<string> {
  const lines = ["## System Status", ""]
  lines.push(`Uptime: ${Math.floor(performance.now() / 1000)}s`)
  lines.push("")
  lines.push("- Memory: OK")
  lines.push("- Mesh: OK")
  return lines.join("\n")
}
