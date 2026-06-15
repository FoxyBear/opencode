/**
 * Spec 16 §D — Global memory backend registry.
 *
 * Mirrors the graph backend singleton pattern in src/memory/graph/index.ts.
 * When a SurrealBackend (or any MemoryBackend) is registered here, the
 * Memory namespace in memory.ts dispatches reads/writes through it instead
 * of falling back to the legacy SQLite/Drizzle path.
 */

import type { MemoryBackend } from "./backend"
import { Log } from "../util/log"

const log = Log.create({ service: "memory.backend-registry" })

let _globalMemoryBackend: MemoryBackend | null = null

export function setGlobalMemoryBackend(backend: MemoryBackend | null): void {
  _globalMemoryBackend = backend
  if (backend) {
    log.info("global memory backend registered", { type: backend.constructor.name })
  } else {
    log.info("global memory backend cleared")
  }
}

export function getGlobalMemoryBackend(): MemoryBackend | null {
  return _globalMemoryBackend
}

export type MemoryBackendType = "sqlite" | "surreal" | "remote"

export async function createMemoryBackend(
  type: MemoryBackendType,
  opts?: { db?: any; daemonUrl?: string; surreal?: { url?: string; username?: string; password?: string; namespace?: string; database?: string } },
): Promise<MemoryBackend | null> {
  if (type === "surreal") {
    const { SurrealBackend } = await import("./surreal-backend")
    return new SurrealBackend(opts?.db ? { db: opts.db, ...opts.surreal } : opts?.surreal ?? {})
  }
  if (type === "remote") {
    if (!opts?.daemonUrl) throw new Error("remote backend requires daemonUrl")
    const { RemoteMemoryBackend } = await import("./remote-backend")
    return new RemoteMemoryBackend(opts.daemonUrl)
  }
  return null
}
