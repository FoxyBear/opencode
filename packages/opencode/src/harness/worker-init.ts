import { Log } from "@/util/log"
import { getGlobalConfig } from "@/config/bridge"
import { hookPersonaDefault } from "../cli/cmd/tui/worker-persona-hook"
import { initMemoryBackendFromConfig } from "../memory/init"
import { Mesh } from "../mesh/mesh"
import { getGlobalMemoryBackend, setGlobalMemoryBackend } from "../memory/backend-registry"
import { TelegramBot } from "../telegram/bot"

let _meshInitialized = false
async function initMesh() {
  if (_meshInitialized) return
  _meshInitialized = true

  const cfg = await getGlobalConfig()
  if (!cfg?.mesh?.enabled) return

  await Mesh.start({
    enabled: true,
    name: cfg.mesh.name || "",
    secret: cfg.mesh.secret || "",
    mdns: cfg.mesh.mdns ?? true,
    port: 0,
    elevated: cfg.owner?.elevated === true,
  })
  Log.Default.info("mesh started")
}

let _memoryBackendInitialized = false
async function initMemoryBackend() {
  if (_memoryBackendInitialized) return
  _memoryBackendInitialized = true

  // Don't overwrite a backend already set by daemon lifecycle
  if (getGlobalMemoryBackend()) return

  const cfg = await getGlobalConfig()
  const backendType = (cfg?.memory?.graph_backend ?? "sqlite") as "sqlite" | "surreal"
  await initMemoryBackendFromConfig(backendType)
}

let _telegramInitialized = false
async function initTelegram() {
  if (_telegramInitialized) return
  _telegramInitialized = true

  const cfg = await getGlobalConfig()
  if (cfg?.telegram?.enabled && cfg.telegram.bot_token) {
    TelegramBot.configure(cfg.telegram)
    Log.Default.info("telegram config loaded")
  }
}

export async function initHarnessServices() {
  await Promise.allSettled([
    initMemoryBackend().catch((error) => {
      Log.Default.warn("memory backend init failed, falling back to SQLite", {
        error: error instanceof Error ? error.message : error,
      })
    }),
    initMesh().catch((error) => {
      Log.Default.warn("mesh init failed", {
        error: error instanceof Error ? error.message : error,
      })
    }),
    initTelegram().catch((error) => {
      Log.Default.warn("telegram config init failed", {
        error: error instanceof Error ? error.message : error,
      })
    }),
  ])
}

export function initAll(directory: string) {
  hookPersonaDefault(directory).catch((error) => {
    Log.Default.warn("hookPersonaDefault threw", {
      error: error instanceof Error ? error.message : error,
    })
  })

  initMemoryBackend().catch((error) => {
    Log.Default.warn("memory backend init failed, falling back to SQLite", {
      error: error instanceof Error ? error.message : error,
    })
  })

  initMesh().catch((error) => {
    Log.Default.warn("mesh init failed", {
      error: error instanceof Error ? error.message : error,
    })
  })

  initTelegram().catch((error) => {
    Log.Default.warn("telegram config init failed", {
      error: error instanceof Error ? error.message : error,
    })
  })
}

const HARNESS_PATHS = new Set(["/status", "/health", "/memory/list", "/memory/forget"])

export async function handleHarnessRoute(url: URL, body?: string): Promise<{ status: number; headers: Record<string, string>; body: string } | null> {
  const path = url.pathname
  if (!HARNESS_PATHS.has(path)) return null

  Log.Default.debug("harness route", { path })

  const json = (data: unknown, status = 200) => ({
    status,
    headers: { "content-type": "application/json" } as Record<string, string>,
    body: JSON.stringify(data),
  })

  if (path === "/status" || path === "/health") {
    const peers = await Mesh.peers().catch(() => [])
    const uptimeMs = performance.now()
    return json({
      status: "running",
      uptime_seconds: Math.floor(uptimeMs / 1000),
      active_sessions: 0,
      queued_tasks: 0,
      subsystems: {
        mesh: peers.length > 0 || _meshInitialized,
        memory: _memoryBackendInitialized,
      },
      peers: peers.map((p: any) => ({ name: p.name, status: p.status })),
      mesh_peers: peers.length,
    })
  }

  if (path === "/memory/list") {
    const backend = getGlobalMemoryBackend()
    if (!backend) return json({ error: "memory backend not available" }, 503)
    const parsed = body ? JSON.parse(body) : {}
    const results = await backend.list(parsed.persona ?? "default", parsed.limit ?? 50)
    return json(results)
  }

  if (path === "/memory/forget") {
    const backend = getGlobalMemoryBackend()
    if (!backend) return json({ error: "memory backend not available" }, 503)
    if (!body) return json({ error: "missing body" }, 400)
    const { id } = JSON.parse(body)
    await backend.forget(id)
    return json({ ok: true })
  }

  return null
}

export async function shutdown() {
  const memBackend = getGlobalMemoryBackend()
  if (memBackend) {
    await memBackend.close()
    setGlobalMemoryBackend(null)
  }

  await Mesh.stop()
}
