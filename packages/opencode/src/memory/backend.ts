/**
 * Spec 16 §D — Memory backend abstraction.
 *
 * Project/global memory storage is pluggable: SqliteBackend (legacy),
 * SurrealBackend (recommended), Neo4jBackend (remote). All implementations
 * satisfy the same contract and route through `config.memory.graph_backend`.
 */

export interface MemoryBackend {
  /** §D-01 — Initialize storage (open DB, ensure schema). Idempotent. */
  init(): Promise<void>

  /** Release any resources (connections, file handles). Idempotent. */
  close(): Promise<void>

  /** §D-02..D-04 — Persist a memory and any extracted entities/edges. */
  write(input: WriteInput): Promise<{ id: string }>

  /** §D-05 — Hybrid retrieval (vector + keyword + graph), reranked. */
  query(input: QueryInput): Promise<MemoryResult[]>

  /** §D-07 — Counts for /status. */
  metrics(): Promise<BackendMetrics>

  /** §D-09 — Delete a memory by id and clean up related edges. */
  forget(id: string): Promise<void>

  /** §D-10 — List memories for a persona, ordered by accessed_at DESC. */
  list(persona: string, limit?: number): Promise<MemoryResult[]>

  /** §D-11 — Return memories older than ttl_days (by accessed_at). */
  getPrunable(ttl_days: number): Promise<MemoryResult[]>

  /** §D-08 — One-shot import from the legacy SQLite store. Optional. */
  migrateFromSqlite?(): Promise<MigrationReport>
}

export interface WriteInput {
  readonly content: string
  readonly embedding?: Float32Array | null
  readonly scope: "instance" | "project" | "global"
  readonly project_id?: string
  readonly persona: string
  readonly source_session_id?: string
  readonly supersedes_memory_id?: string
  readonly metadata?: Record<string, unknown>
  /** When known; otherwise the backend stamps `now()`. */
  readonly created_at?: string
  /** When the caller already has an id (e.g. migration). Otherwise generated. */
  readonly id?: string
}

export interface QueryInput {
  readonly query: string
  readonly queryEmbedding: Float32Array
  readonly scope: "instance" | "project" | "global" | "all"
  readonly project_id?: string
  /**
   * §D-06 — ISO 8601. When set, only edges valid at that point in time
   * contribute to the graph leg.
   */
  readonly as_of?: string
  /** Default 20. */
  readonly limit?: number
  readonly persona?: string
}

export interface MemoryResult {
  readonly id: string
  readonly content: string
  readonly persona: string
  readonly scope: string
  /** Post-RRF score; not directly comparable across queries. */
  readonly score: number
  readonly source: "surreal" | "sqlite" | "workforce"
  readonly metadata: Record<string, unknown>
  readonly created_at: string
  readonly accessed_at: string
}

export interface BackendMetrics {
  readonly instance_count: number
  readonly project_count: number
  readonly global_count: number
  readonly edge_count: number
}

export interface MigrationReport {
  readonly memories: number
  readonly entities: number
  readonly edges: number
  readonly duration_ms: number
  /** False on a no-op (already migrated). */
  readonly ran: boolean
}
