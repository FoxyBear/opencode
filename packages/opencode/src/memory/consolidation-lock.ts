import fs from "fs"
import path from "path"
import { Log } from "../util/log"

const log = Log.create({ service: "memory.consolidation.lock" })

// ── Lock management (CN-12, CN-13, CN-14) ──

const LOCK_FILENAME = ".consolidate-lock"
const LOCK_MAX_AGE_MS = 60 * 60 * 1000 // 1 hour

interface LockData {
  pid: number
  timestamp: number
}

function getLockPath(lockDir: string): string {
  return path.join(lockDir, LOCK_FILENAME)
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readLock(lockPath: string): LockData | null {
  try {
    if (!fs.existsSync(lockPath)) return null
    const data = JSON.parse(fs.readFileSync(lockPath, "utf-8"))
    if (typeof data.pid !== "number" || typeof data.timestamp !== "number") return null
    return data as LockData
  } catch {
    return null
  }
}

export function writeLock(lockDir: string): void {
  const lockPath = getLockPath(lockDir)
  const data: LockData = { pid: process.pid, timestamp: Date.now() }
  fs.writeFileSync(lockPath, JSON.stringify(data))
}

export function removeLock(lockDir: string): void {
  const lockPath = getLockPath(lockDir)
  try {
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath)
    }
  } catch (err) {
    log.warn("consolidation: failed to remove lock file", { error: String(err) })
  }
}

/**
 * CN-12 + CN-13: Check if a consolidation lock prevents running.
 * Returns true if lock blocks us, false if we can proceed.
 * Removes stale locks.
 */
export function isLockedOut(lockDir: string): boolean {
  const lockPath = getLockPath(lockDir)
  const lock = readLock(lockPath)

  if (!lock) return false

  const lockAge = Date.now() - lock.timestamp
  const pidAlive = isPidAlive(lock.pid)

  // CN-12: Lock exists AND PID alive AND lock < 1 hour -> blocked
  if (pidAlive && lockAge < LOCK_MAX_AGE_MS) {
    return true
  }

  // CN-13: Lock exists but PID dead OR lock > 1 hour -> stale, remove it
  log.info("consolidation: removing stale lock", {
    pid: lock.pid,
    pidAlive,
    lockAgeMs: lockAge,
  })
  removeLock(lockDir)
  return false
}
