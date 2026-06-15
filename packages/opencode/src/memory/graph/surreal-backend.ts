/**
 * Spec 16 §D / SG-01..SG-04 — SurrealGraphBackend.
 *
 * Bridges the daemon's existing GraphBackend interface
 * (`src/memory/graph/backend.ts`) to the SurrealDB embedded engine that
 * SurrealBackend (MemoryBackend) already uses.
 *
 * Source spec: docs/260427_foxybear_spec-surreal-graph-backend.md
 *
 * Design choices (documented per SG-01):
 *  - Owns its own SurrealDB connection. Sharing with SurrealBackend would
 *    couple lifecycles for marginal gain; one DB process serves both clients
 *    just fine and keeps reset/teardown isolated for tests.
 *  - Stores entities/edges in dedicated tables `graph_entity` + `graph_edge`,
 *    distinct from SurrealBackend's `entity` + `relates` tables. The two
 *    impls have different bi-temporal field semantics (ms-number vs ISO-string)
 *    and unifying them is out of scope for this task. Init still runs the
 *    SurrealBackend table-defs idempotently so a single connection can serve
 *    both surfaces if a future refactor wants it.
 *  - Reuses bm25Rank + rrf via src/memory/retrieval-helpers.ts (extracted
 *    from surreal-backend.ts in a follow-up commit).
 *
 * SDK quirks honored (deferred-items §5):
 *  - `db.create(thing, data)` silently drops `data` → use raw
 *    `CREATE … CONTENT ${JSON.stringify(...)}`.
 *  - `DELETE table` throws on nonexistent table → `DEFINE TABLE IF NOT EXISTS`
 *    at init().
 *  - Record IDs that aren't valid bare identifiers (ULIDs start with a digit)
 *    need angle-bracket form: `graph_entity:⟨${id}⟩`.
 */
import { ulid } from "ulid"
import { Log } from "../../util/log"
import { cosineSimilarity } from "../memory"
import type { GraphBackend, EntityInput, EdgeInput } from "./backend"
import type { GraphEntity, GraphEdge, GraphQueryResult, TraversalResult, EdgeType, EntityType } from "./types"

const log = Log.create({ service: "graph.surreal" })

export interface SurrealGraphBackendOptions {
  url?: string
  username?: string
  password?: string
  namespace?: string
  database?: string
}

export class SurrealGraphBackend implements GraphBackend {
  private url: string
  private username: string
  private password: string
  private namespace: string
  private database: string
  private db: any

  getDb(): any { return this.db }
  private opened = false

  constructor(opts: SurrealGraphBackendOptions = {}) {
    this.url = opts.url ?? "ws://127.0.0.1:8000"
    this.username = opts.username ?? "root"
    this.password = opts.password ?? "root"
    this.namespace = opts.namespace ?? "foxybear"
    this.database = opts.database ?? "memory"
  }

  async init(): Promise<void> {
    if (this.opened) return

    const { Surreal } = await import("surrealdb")
    this.db = new Surreal()
    await this.db.connect(this.url)
    await this.db.signin({ username: this.username, password: this.password })
    await this.db.use({ namespace: this.namespace, database: this.database })

    // Define both SurrealBackend's tables AND our own. Idempotent.
    // Defining MemoryBackend's tables here means a single connection can
    // serve both (when a future refactor consolidates them) and `_reset`
    // never trips the `DELETE-on-nonexistent-table` quirk.
    await this.db.query(`
      DEFINE TABLE IF NOT EXISTS memory SCHEMALESS;
      DEFINE TABLE IF NOT EXISTS entity SCHEMALESS;
      DEFINE TABLE IF NOT EXISTS mentions TYPE RELATION FROM memory TO entity SCHEMALESS;
      DEFINE TABLE IF NOT EXISTS relates TYPE RELATION FROM entity TO entity SCHEMALESS;
      DEFINE TABLE IF NOT EXISTS supersedes TYPE RELATION FROM memory TO memory SCHEMALESS;
      DEFINE TABLE IF NOT EXISTS graph_entity SCHEMALESS;
      DEFINE TABLE IF NOT EXISTS graph_edge SCHEMALESS;
    `)

    this.opened = true
    log.info("surreal graph backend initialized", { url: this.url, namespace: this.namespace })
  }

  async close(): Promise<void> {
    if (this.db) {
      try {
        await this.db.close()
      } catch {}
      this.db = undefined
    }
    this.opened = false
  }

  healthy(): boolean {
    return this.opened
  }

  async upsertEntity(input: EntityInput): Promise<GraphEntity> {
    if (!this.opened) throw new Error("SurrealGraphBackend not initialized")
    const now = Date.now()

    // Find existing entity by (name, project_id) per SG-01: update in place
    // (preserve valid_from), else create.
    const existing = await this.findEntitiesByName(input.name, input.project_id)
    const live = existing.find((e) => e.invalid_from == null)
    const id = live ? live.id : ulid()

    const fields = {
      id,
      project_id: input.project_id,
      name: input.name,
      entity_type: input.entity_type,
      content: input.content,
      embedding: input.embedding ? Array.from(input.embedding) : null,
      metadata: input.metadata ?? {},
      valid_from: live ? live.valid_from : now,
      invalid_from: null,
      time_created: live ? live.created_at : now,
      time_updated: now,
    }

    if (live) {
      await this.run(
        `UPDATE graph_entity:⟨${id}⟩ CONTENT ${JSON.stringify(fields)};`,
      )
    } else {
      await this.run(
        `CREATE graph_entity:⟨${id}⟩ CONTENT ${JSON.stringify(fields)};`,
      )
    }

    return {
      id,
      project_id: input.project_id,
      name: input.name,
      entity_type: input.entity_type,
      content: input.content,
      embedding: input.embedding,
      metadata: input.metadata,
      valid_from: fields.valid_from,
      created_at: fields.time_created,
      updated_at: fields.time_updated,
    }
  }

  async getEntity(id: string): Promise<GraphEntity | undefined> {
    if (!this.opened) throw new Error("SurrealGraphBackend not initialized")
    const rows = await this.run(
      `SELECT * FROM graph_entity WHERE id = graph_entity:⟨${escapeId(id)}⟩;`,
    )
    if (rows.length === 0) return undefined
    return entityFromRow(rows[0])
  }

  async findEntitiesByName(name: string, project_id: string): Promise<GraphEntity[]> {
    if (!this.opened) throw new Error("SurrealGraphBackend not initialized")
    const rows = await this.run(
      `SELECT * FROM graph_entity
       WHERE name = "${escapeStr(name)}"
         AND project_id = "${escapeStr(project_id)}"
         AND invalid_from IS NULL;`,
    )
    return rows.map(entityFromRow)
  }

  async searchEntities(input: {
    embedding: Float32Array
    project_id: string
    limit?: number
    include_global?: boolean
  }): Promise<Array<GraphEntity & { score: number }>> {
    if (!this.opened) throw new Error("SurrealGraphBackend not initialized")
    const limit = input.limit ?? 10

    const projectClause = input.include_global
      ? `(project_id = "${escapeStr(input.project_id)}" OR project_id = "global")`
      : `project_id = "${escapeStr(input.project_id)}"`

    // SurrealQL's `vector::similarity::cosine` doesn't currently sort+limit
    // cleanly across embedded engine builds for arbitrary float arrays; we
    // pull candidates and rank in TS. With graph_entity row counts staying
    // small (entities, not memories), this is fine. Switch to a SurrealQL
    // ORDER BY when we observe latency.
    const rows = await this.run(
      `SELECT * FROM graph_entity
       WHERE ${projectClause} AND invalid_from IS NULL;`,
    )

    const scored = rows
      .map((row: any) => entityFromRow(row))
      .filter((e: GraphEntity) => e.embedding)
      .map((e: GraphEntity) => ({
        ...e,
        score: cosineSimilarity(input.embedding, e.embedding!),
      }))
      .sort((a: any, b: any) => b.score - a.score)
      .slice(0, limit)

    return scored
  }

  async addEdge(input: EdgeInput): Promise<GraphEdge> {
    if (!this.opened) throw new Error("SurrealGraphBackend not initialized")
    const now = Date.now()
    const id = ulid()

    const fields = {
      id,
      project_id: input.project_id,
      source_id: input.source_id,
      target_id: input.target_id,
      edge_type: input.edge_type,
      weight: input.weight ?? 1.0,
      valid_from: input.valid_from,
      invalid_from: null,
      source_project: input.source_project ?? null,
      metadata: input.metadata ?? {},
      time_created: now,
      time_updated: now,
    }

    await this.run(
      `CREATE graph_edge:⟨${id}⟩ CONTENT ${JSON.stringify(fields)};`,
    )

    return {
      id,
      project_id: input.project_id,
      source_id: input.source_id,
      target_id: input.target_id,
      edge_type: input.edge_type,
      weight: input.weight ?? 1.0,
      valid_from: input.valid_from,
      source_project: input.source_project,
      metadata: input.metadata,
      created_at: now,
      updated_at: now,
    }
  }

  async invalidateEdge(id: string, invalid_from: number): Promise<void> {
    if (!this.opened) throw new Error("SurrealGraphBackend not initialized")
    await this.run(
      `UPDATE graph_edge:⟨${escapeId(id)}⟩ SET invalid_from = ${invalid_from}, time_updated = ${Date.now()};`,
    )
  }

  async getEdgesFrom(entity_id: string, opts?: { valid_only?: boolean }): Promise<GraphEdge[]> {
    if (!this.opened) throw new Error("SurrealGraphBackend not initialized")
    const validClause = opts?.valid_only !== false ? `AND invalid_from IS NULL` : ""
    const rows = await this.run(
      `SELECT * FROM graph_edge WHERE source_id = "${escapeStr(entity_id)}" ${validClause};`,
    )
    return rows.map(edgeFromRow)
  }

  async getEdgesTo(entity_id: string, opts?: { valid_only?: boolean }): Promise<GraphEdge[]> {
    if (!this.opened) throw new Error("SurrealGraphBackend not initialized")
    const validClause = opts?.valid_only !== false ? `AND invalid_from IS NULL` : ""
    const rows = await this.run(
      `SELECT * FROM graph_edge WHERE target_id = "${escapeStr(entity_id)}" ${validClause};`,
    )
    return rows.map(edgeFromRow)
  }

  async traverse(input: {
    start_id: string
    max_hops: number
    edge_types?: EdgeType[]
    valid_only?: boolean
  }): Promise<TraversalResult[]> {
    if (!this.opened) throw new Error("SurrealGraphBackend not initialized")
    const validOnly = input.valid_only !== false
    const maxHops = Math.min(input.max_hops, 3)

    // BFS via repeated 1-hop queries. SurrealQL has graph-path syntax
    // (`->graph_edge->graph_entity`) but it's targeted at RELATION-typed
    // tables. Our `graph_edge` is a regular table with source_id/target_id
    // string fields, so iterative BFS keeps the impl portable across SDK
    // versions. With BFS depth ≤ 3 and per-frontier batches, latency stays
    // O(degree × depth).
    const visited = new Set<string>([input.start_id])
    let frontier = [input.start_id]
    const results: TraversalResult[] = []

    for (let depth = 1; depth <= maxHops; depth++) {
      if (frontier.length === 0) break
      const nextFrontier: string[] = []
      for (const nodeId of frontier) {
        const edges = await this.getEdgesFrom(nodeId, { valid_only: validOnly })
        for (const edge of edges) {
          if (input.edge_types && !input.edge_types.includes(edge.edge_type)) continue
          if (visited.has(edge.target_id)) continue
          visited.add(edge.target_id)
          const entity = await this.getEntity(edge.target_id)
          if (entity && (entity.invalid_from == null || !validOnly)) {
            results.push({ entity, depth })
            nextFrontier.push(edge.target_id)
          }
        }
      }
      frontier = nextFrontier
    }

    return results
  }

  async query(input: {
    project_id: string
    embedding?: Float32Array
    keyword?: string
    limit?: number
    include_global?: boolean
  }): Promise<GraphQueryResult> {
    if (!this.opened) throw new Error("SurrealGraphBackend not initialized")
    const limit = input.limit ?? 10
    let entities: Array<GraphEntity & { score: number }> = []

    if (input.embedding) {
      entities = await this.searchEntities({
        embedding: input.embedding,
        project_id: input.project_id,
        limit,
        include_global: input.include_global,
      })
    }

    if (input.keyword) {
      const projectClause = input.include_global
        ? `(project_id = "${escapeStr(input.project_id)}" OR project_id = "global")`
        : `project_id = "${escapeStr(input.project_id)}"`
      const kw = input.keyword.toLowerCase()
      const rows = await this.run(
        `SELECT * FROM graph_entity
         WHERE ${projectClause}
           AND invalid_from IS NULL
           AND string::lowercase(content) CONTAINS "${escapeStr(kw)}"
         LIMIT ${limit};`,
      )
      const keywordEntities = rows.map((r: any) => ({ ...entityFromRow(r), score: 0.5 }))
      const existingIds = new Set(entities.map((e) => e.id))
      for (const ke of keywordEntities) {
        if (!existingIds.has(ke.id)) {
          entities.push(ke)
          existingIds.add(ke.id)
        }
      }
    }

    entities = entities.sort((a, b) => b.score - a.score).slice(0, limit)

    // Get edges for found entities. Mirrors SqliteGraphBackend.query semantics:
    // include outgoing edges to in-set targets, plus any SUPERSEDES/CONTRADICTS
    // (which are useful even if the target isn't in the result set).
    const entityIds = new Set(entities.map((e) => e.id))
    const edges: GraphEdge[] = []
    for (const entity of entities) {
      const outEdges = await this.getEdgesFrom(entity.id)
      for (const edge of outEdges) {
        if (
          entityIds.has(edge.target_id) ||
          edge.edge_type === "SUPERSEDES" ||
          edge.edge_type === "CONTRADICTS"
        ) {
          edges.push(edge)
        }
      }
    }

    return { entities, edges }
  }

  async _reset(): Promise<void> {
    if (!this.opened) return
    await this.run(`DELETE graph_edge; DELETE graph_entity;`)
  }

  /** Internal: run SurrealQL, return rows of last statement. Mirrors SurrealBackend.run. */
  async run(surql: string): Promise<any[]> {
    const out = await this.db.query(surql)
    if (!Array.isArray(out)) return []
    if (out.length === 1 && Array.isArray(out[0])) return out[0] as any[]
    const last = out[out.length - 1]
    return Array.isArray(last) ? (last as any[]) : []
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function escapeStr(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

/** Sanitize a record-id for inlining inside `graph_entity:⟨${id}⟩`. */
function escapeId(s: string): string {
  // Angle brackets accept arbitrary strings; we only need to prevent the
  // closing `⟩` from prematurely terminating the literal.
  return s.replace(/⟩/g, "")
}

function rowId(row: any): string {
  // SurrealDB SDK returns RecordId objects with `.tb` and `.id` fields, or
  // strings of the form "graph_entity:⟨…⟩" depending on call shape. Normalize
  // to the raw inner id string.
  if (row == null) return ""
  if (typeof row === "string") {
    const idx = row.indexOf(":")
    if (idx < 0) return row
    let inner = row.slice(idx + 1)
    if (inner.startsWith("⟨") && inner.endsWith("⟩")) inner = inner.slice(1, -1)
    return inner
  }
  if (typeof row === "object") {
    if (typeof row.id === "string" || typeof row.id === "number") return String(row.id)
    if (row.id?.id != null) return String(row.id.id)
    if (row.id?.tb && row.id?.id != null) return String(row.id.id)
  }
  return ""
}

function entityFromRow(row: any): GraphEntity {
  return {
    id: row.id != null ? rowId(row) : "",
    project_id: String(row.project_id ?? ""),
    name: String(row.name ?? ""),
    entity_type: String(row.entity_type ?? "concept") as EntityType,
    content: String(row.content ?? ""),
    embedding: Array.isArray(row.embedding) ? Float32Array.from(row.embedding) : undefined,
    metadata: (row.metadata as Record<string, unknown>) ?? undefined,
    valid_from: Number(row.valid_from ?? 0),
    invalid_from: row.invalid_from != null ? Number(row.invalid_from) : undefined,
    created_at: Number(row.time_created ?? 0),
    updated_at: Number(row.time_updated ?? 0),
  }
}

function edgeFromRow(row: any): GraphEdge {
  return {
    id: rowId(row),
    project_id: String(row.project_id ?? ""),
    source_id: String(row.source_id ?? ""),
    target_id: String(row.target_id ?? ""),
    edge_type: String(row.edge_type ?? "RELATES_TO") as EdgeType,
    weight: Number(row.weight ?? 1.0),
    valid_from: Number(row.valid_from ?? 0),
    invalid_from: row.invalid_from != null ? Number(row.invalid_from) : undefined,
    source_project: row.source_project ?? undefined,
    metadata: (row.metadata as Record<string, unknown>) ?? undefined,
    created_at: Number(row.time_created ?? 0),
    updated_at: Number(row.time_updated ?? 0),
  }
}
