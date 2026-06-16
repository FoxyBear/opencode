import { Log } from "../util/log"

const log = Log.create({ service: "daemon.lifecycle" })

export interface SubsystemDef {
  name: string
  fatal: boolean
  init(): Promise<void>
  stop(): Promise<void>
}

export namespace DaemonLifecycle {
  let _running = false
  let _subsystems: SubsystemDef[] = []
  let _healthy: Map<string, { healthy: boolean; error?: string }> = new Map()
  let _startTime = 0

  export async function start(opts: { subsystems: SubsystemDef[] }): Promise<void> {
    _subsystems = opts.subsystems
    _startTime = Date.now()
    _running = true

    for (const sub of _subsystems) {
      try {
        await sub.init()
        _healthy.set(sub.name, { healthy: true })
        log.info("subsystem started", { name: sub.name })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        _healthy.set(sub.name, { healthy: false, error: msg })
        log.error("subsystem init failed", { name: sub.name, error: msg })
        if (sub.fatal) {
          await stop()
          throw new Error(`Fatal subsystem failure: ${sub.name}: ${msg}`)
        }
      }
    }

    process.on("SIGTERM", () => stop().then(() => process.exit(0)))
    process.on("SIGINT", () => stop().then(() => process.exit(0)))
  }

  export async function stop(): Promise<void> {
    if (!_running) return
    _running = false

    for (const sub of [..._subsystems].reverse()) {
      try {
        await sub.stop()
        log.info("subsystem stopped", { name: sub.name })
      } catch (err) {
        log.error("subsystem stop failed", { name: sub.name, error: String(err) })
      }
    }
  }

  export function isRunning(): boolean {
    return _running
  }

  export function getUptime(): number {
    return _running ? Math.floor((Date.now() - _startTime) / 1000) : 0
  }

  export function getSubsystems(): Array<{ name: string; healthy: boolean; error?: string }> {
    return Array.from(_healthy.entries()).map(([name, info]) => ({ name, ...info }))
  }
}
