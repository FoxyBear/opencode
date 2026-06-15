import { Log } from "@/util/log"
import { getGlobalConfig } from "@/config/bridge"
import { initMemoryBackendFromConfig } from "../memory/init"
import { Mesh } from "../mesh/mesh"
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
