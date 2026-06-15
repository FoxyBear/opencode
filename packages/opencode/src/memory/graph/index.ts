import type { GraphBackend } from "./backend"
import { SqliteGraphBackend } from "./sqlite-backend"
import { Neo4jGraphBackend } from "./neo4j-backend"
import { SurrealGraphBackend } from "./surreal-backend"
import { Log } from "../../util/log"

const log = Log.create({ service: "memory.graph" })

export type { GraphBackend, EntityInput, EdgeInput } from "./backend"
export type { GraphEntity, GraphEdge, GraphQueryResult, TraversalResult, EntityType, EdgeType } from "./types"

// Singleton graph backend managed by the daemon
let _globalBackend: GraphBackend | null = null

export function setGlobalGraphBackend(backend: GraphBackend | null): void {
  _globalBackend = backend
}

export function getGlobalGraphBackend(): GraphBackend | null {
  return _globalBackend
}

export type GraphBackendType = "sqlite" | "neo4j" | "surreal"

export interface GraphBackendCreateOptions {
  surreal?: { url?: string; username?: string; password?: string; namespace?: string; database?: string }
}

export function createGraphBackend(type: GraphBackendType, opts?: GraphBackendCreateOptions): GraphBackend {
  if (type === "neo4j") return new Neo4jGraphBackend()
  if (type === "surreal") {
    return new SurrealGraphBackend(opts?.surreal)
  }
  return new SqliteGraphBackend()
}
