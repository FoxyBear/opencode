import { DaemonPid } from "../daemon/pid"
import { createMemoryBackend, setGlobalMemoryBackend } from "./backend-registry"
import { NoOpMemoryBackend } from "./noop-backend"
import { Log } from "../util/log"

const PID_RETRY_COUNT = 3
const PID_RETRY_DELAY_MS = 500

export async function resolveDaemonPort(pidFile?: string): Promise<number | undefined> {
  for (let attempt = 0; attempt < PID_RETRY_COUNT; attempt++) {
    const status = DaemonPid.check(pidFile)
    if (status.state !== "running") return undefined
    if (status.port !== undefined) return status.port
    if (attempt < PID_RETRY_COUNT - 1) {
      await new Promise((r) => setTimeout(r, PID_RETRY_DELAY_MS))
    }
  }
  return undefined
}

export async function initMemoryBackendFromConfig(
  backendType: "sqlite" | "surreal",
  pidFile?: string,
): Promise<void> {
  if (backendType === "surreal") {
    const daemonPort = await resolveDaemonPort(pidFile)
    if (daemonPort !== undefined) {
      try {
        const backend = await createMemoryBackend("remote", { daemonUrl: `http://127.0.0.1:${daemonPort}` })
        if (backend) {
          await backend.init()
          setGlobalMemoryBackend(backend)
          Log.Default.info("memory backend initialized (remote proxy)", { port: daemonPort })
          return
        }
      } catch (err) {
        Log.Default.warn("daemon memory subsystem unavailable, registering NoOpMemoryBackend", {
          error: err instanceof Error ? err.message : err,
        })
        setGlobalMemoryBackend(new NoOpMemoryBackend("daemon memory subsystem unavailable"))
        return
      }
    }
    Log.Default.warn("memory unavailable: daemon not running")
    setGlobalMemoryBackend(new NoOpMemoryBackend("no daemon running — start with 'foxybear serve'"))
    return
  }

  try {
    const backend = await createMemoryBackend(backendType)
    if (backend) {
      await backend.init()
      setGlobalMemoryBackend(backend)
      Log.Default.info("memory backend initialized", { type: backendType })
    }
  } catch (err) {
    Log.Default.warn("memory backend init failed", {
      requested: backendType,
      error: err instanceof Error ? err.message : err,
    })
  }
}
