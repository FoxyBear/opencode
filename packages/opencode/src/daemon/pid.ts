import fs from "fs"
import path from "path"
import { Global } from "../global"
import { Log } from "../util/log"

const log = Log.create({ service: "daemon.pid" })

const PID_FILENAME = "foxybear-serve.pid"

interface PidData {
  pid: number
  timestamp: number
  port?: number
}

function defaultPidPath(): string {
  return path.join(Global.Path.data, PID_FILENAME)
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readPidFile(pidPath: string): PidData | null {
  try {
    if (!fs.existsSync(pidPath)) return null
    const data = JSON.parse(fs.readFileSync(pidPath, "utf-8"))
    if (typeof data.pid !== "number" || typeof data.timestamp !== "number") return null
    return data as PidData
  } catch {
    return null
  }
}

export interface DaemonStatus {
  state: "running" | "stopped" | "stale"
  pid?: number
  port?: number
}

export namespace DaemonPid {
  export function check(pidFile?: string): DaemonStatus {
    const pidPath = pidFile ?? defaultPidPath()
    const data = readPidFile(pidPath)
    if (!data) return { state: "stopped" }
    if (isPidAlive(data.pid)) {
      return { state: "running", pid: data.pid, port: data.port }
    }
    return { state: "stale", pid: data.pid }
  }

  export function acquire(pidFile?: string): void {
    const pidPath = pidFile ?? defaultPidPath()
    const status = check(pidPath)

    if (status.state === "running") {
      throw new Error(`Daemon already running (PID ${status.pid})`)
    }

    if (status.state === "stale") {
      log.info("reclaiming stale PID file", { stalePid: status.pid })
      remove(pidPath)
    }

    const data: PidData = { pid: process.pid, timestamp: Date.now() }
    fs.writeFileSync(pidPath, JSON.stringify(data))
    log.info("PID file written", { pid: process.pid, path: pidPath })
  }

  export function write(port: number, pidFile?: string): void {
    const pidPath = pidFile ?? defaultPidPath()
    const data: PidData = { pid: process.pid, timestamp: Date.now(), port }
    fs.writeFileSync(pidPath, JSON.stringify(data))
  }

  export function updatePort(port: number, pidFile?: string): void {
    const pidPath = pidFile ?? defaultPidPath()
    const data = readPidFile(pidPath)
    if (!data) return
    data.port = port
    fs.writeFileSync(pidPath, JSON.stringify(data))
    log.info("PID file updated with port", { port })
  }

  export function remove(pidFile?: string): void {
    const pidPath = pidFile ?? defaultPidPath()
    try {
      if (fs.existsSync(pidPath)) {
        fs.unlinkSync(pidPath)
        log.info("PID file removed", { path: pidPath })
      }
    } catch (err) {
      log.warn("failed to remove PID file", { error: String(err) })
    }
  }

  export function readPid(pidFile?: string): number | null {
    const pidPath = pidFile ?? defaultPidPath()
    const data = readPidFile(pidPath)
    return data?.pid ?? null
  }

  export function getDefaultPath(): string {
    return defaultPidPath()
  }
}
