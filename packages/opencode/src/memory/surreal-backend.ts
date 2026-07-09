/**
 * Spec 16 §D — SurrealBackend.
 *
 * Embedded SurrealDB engine via @surrealdb/node. Recommended backend per
 * docs/research/260427_foxybear_research-graph-db-spike-results.md after
 * the graph-DB spike (task #13) found Kuzu's Bun friction outweighed the
 * benefits and SurrealDB embedded passed every test cleanly.
 *
 * Design contract: docs/260427_foxybear_spec-memory-backend-kuzu.md (the
 * §D behaviors carry forward; only the query layer changes from Cypher to
 * SurrealQL).
 */
import { ulid } from "ulid"
import fs from "fs"
import path from "path"
import { Log } from "../util/log"
import type {
  MemoryBackend,
  WriteInput,
  QueryInput,
  MemoryResult,
  BackendMetrics,
  MigrationReport,
} from "./backend"

const log = Log.create({ service: "memory.surreal" })

const SEMANTIC_LIMIT = 200
const KEYWORD_LIMIT = 200
const RRF_K = 60 // published default; see deferred-items §2 #4

export interface SurrealBackendOptions {
  url?: string
  username?: string
  password?: string
  namespace?: string
  database?: string
  /** Reuse an already-connected Surreal instance. */
  db?: any
}

export class SurrealBackend implements MemoryBackend {
  private url: string
  private username: string
  private password: string
  private namespace: string
  private database: string
  private db: any
  private opened = false

  private shared = false

  constructor(opts: SurrealBackendOptions = {}) {
    this.url = opts.url ?? "ws://127.0.0.1:8000"
    this.username = opts.username ?? "root"
    this.password = opts.password ?? "root"
    this.namespace = opts.namespace ?? "foxybear"
    this.database = opts.database ?? "memory"
    if (opts.db) {
      this.db = opts.db
      this.shared = true
    }
  }

  async init(): Promise<void> {
    if (this.opened) return

    if (!this.db) {
      const { Surreal } = await import("surrealdb")
      this.db = new Surreal()
      await this.db.connect(this.url)
      await this.db.signin({ username: this.username, password: this.password })
      await this.db.use({ namespace: this.namespace, database: this.database })
    }

    await this.db.query(`
      DEFINE TABLE IF NOT EXISTS memory SCHEMALESS;
      DEFINE TABLE IF NOT EXISTS entity SCHEMALESS;
      DEFINE TABLE IF NOT EXISTS mentions TYPE RELATION FROM memory TO entity SCHEMALESS;
      DEFINE TABLE IF NOT EXISTS relates TYPE RELATION FROM entity TO entity SCHEMALESS;
      DEFINE TABLE IF NOT EXISTS supersedes TYPE RELATION FROM memory TO memory SCHEMALESS;
    `)

    this.opened = true
    log.info("surreal backend initialized", { url: this.url, namespace: this.namespace, shared: this.shared })
  }

  async close(): Promise<void> {
    if (this.db && !this.shared) {
      try {
        await this.db.close()
      } catch {}
      this.db = undefined
    }
    this.opened = false
  }

  async write(input: WriteInput): Promise<{ id: string }> {
    if (!this.opened) throw new Error("SurrealBackend not initialized")

    const id = input.id ?? ulid()
    const now = input.created_at ?? new Date().toISOString()
    const projectId = input.project_id ?? ""
    const sessionId = input.source_session_id ?? ""

    const fields = {
      content: input.content,
      embedding: input.embedding ? Array.from(input.embedding) : [],
      persona: input.persona,
      scope: input.scope,
      project_id: projectId,
      source_session_id: sessionId,
      metadata: input.metadata ?? {},
      created_at: now,
      accessed_at: now,
      access_count: 0,
    }

    // Note: surrealdb v2.0.3's `db.create(thing, data)` silently drops the
    // `data` argument in our environment (verified empirically — only the
    // id field comes back). Switching to raw SurrealQL with `CREATE
    // memory:⟨id⟩ CONTENT { ... }` which round-trips correctly.
    // RecordId IDs use angle-bracket form when inlined in SurrealQL.
    await this.run(
      `CREATE memory:⟨${id}⟩ CONTENT ${JSON.stringify(fields)};`,
    )

    if (input.supersedes_memory_id) {
      await this.run(
        `RELATE memory:⟨${id}⟩->supersedes->memory:⟨${input.supersedes_memory_id}⟩ SET valid_from = "${now}", reason = "";`,
      )
    }

    // §D-02 / SG-02 — pattern-based entity extraction. Each extracted entity
    // becomes (or reuses) an `entity` row scoped to (scope, project_id), with
    // a MENTIONS edge from this memory. The extractor is deterministic; see
    // src/memory/extraction.ts.
    await this.extractAndLinkEntities(id, input.content, input.scope, projectId, now)

    return { id }
  }

  /**
   * Extract entities from `content` and link them to the memory via MENTIONS.
   * Reuses an existing entity row when (name, scope, project_id) matches;
   * otherwise creates a new one. Idempotent across repeat writes.
   */
  private async extractAndLinkEntities(
    memoryId: string,
    content: string,
    scope: "instance" | "project" | "global",
    projectId: string,
    nowIso: string,
  ): Promise<void> {
    const { extractEntities } = await import("./extraction")
    const extracted = extractEntities(content)
    if (extracted.length === 0) return

    for (const ent of extracted) {
      // Find or create the entity row for this (name, scope, project_id).
      const escapedName = escapeStr(ent.name)
      const projectClause = projectId ? `AND project_id = "${escapeStr(projectId)}"` : `AND (project_id = "" OR project_id IS NULL)`
      const found = await this.run(
        `SELECT meta::id(id) AS id FROM entity
         WHERE name = "${escapedName}" AND scope = "${scope}" ${projectClause}
         LIMIT 1;`,
      ).catch(() => [] as any[])

      let entityId: string
      if (found.length > 0 && found[0]?.id) {
        entityId = String(found[0].id)
      } else {
        entityId = ulid()
        const fields = {
          name: ent.name,
          entity_type: ent.entity_type,
          scope,
          project_id: projectId,
          embedding: [],
          metadata: {},
          valid_from: nowIso,
          valid_to: "",
        }
        try {
          await this.run(`CREATE entity:⟨${entityId}⟩ CONTENT ${JSON.stringify(fields)};`)
        } catch (err) {
          log.warn("entity-extraction: create failed", { name: ent.name, error: String(err) })
          continue
        }
      }

      // Always create a MENTIONS edge from this memory to the entity.
      try {
        await this.run(
          `RELATE memory:⟨${memoryId}⟩->mentions->entity:⟨${entityId}⟩ SET created_at = "${nowIso}";`,
        )
      } catch (err) {
        log.warn("entity-extraction: mentions edge failed", { name: ent.name, error: String(err) })
      }
    }
  }

  async query(input: QueryInput): Promise<MemoryResult[]> {
    if (!this.opened) throw new Error("SurrealBackend not initialized")

    const limit = input.limit ?? 20
    const projectId = input.project_id ?? ""
    const scopeClause =
      input.scope === "all"
        ? `scope IN ['instance','project','global']`
        : `scope = "${input.scope}"`
    const projectClause = projectId ? `AND (project_id = "${escapeStr(projectId)}" OR project_id = "global" OR project_id = "")` : ""

    // ── Leg 1: semantic ── §D-05a
    const qvec = Array.from(input.queryEmbedding)
    const qvecJson = JSON.stringify(qvec)
    const semanticRows = await this.run(
      `SELECT meta::id(id) AS id,
              vector::similarity::cosine(embedding, ${qvecJson}) AS score
       FROM memory
       WHERE ${scopeClause} ${projectClause}
         AND array::len(embedding) = ${qvec.length}
       ORDER BY score DESC
       LIMIT ${SEMANTIC_LIMIT};`,
    )
    const semanticRanking: string[] = semanticRows.map((r: any) => String(r.id))

    // ── Leg 2: keyword (CONTAINS pre-filter + TS-side BM25) ── §D-05b
    const queryTokens = tokenize(input.query)
    const keywordRanking: string[] = []
    if (queryTokens.length > 0) {
      const candidates = await keywordCandidates(this, queryTokens, scopeClause, projectClause)
      const ranked = bm25Rank(queryTokens, candidates)
      keywordRanking.push(...ranked.map((r) => r.id))
    }

    // ── Leg 3: graph ── §D-05c (1-hop co-mention via mentions)
    // Memories that share at least one mentioned entity with another memory
    // in the same scope. Multi-hop deferred to a follow-up; SurrealDB
    // supports it natively via `->mentions->entity<-mentions<-memory`-style
    // path syntax, but v1 sticks to 1-hop for parity with Kuzu's footprint.
    const asOf = input.as_of ?? new Date().toISOString()
    const graphRows = await this.run(
      `SELECT meta::id(id) AS id, count() AS overlap FROM memory
       WHERE ${scopeClause} ${projectClause}
         AND id IN (
           SELECT VALUE <-mentions<-memory FROM (
             SELECT VALUE ->mentions->entity FROM memory
             WHERE ${scopeClause} ${projectClause}
           )
         )
       GROUP BY id
       ORDER BY overlap DESC
       LIMIT 200;`,
    ).catch(() => [] as any[])
    // The graph leg may return empty in v1 if no entities have been written yet
    // (entity extraction is deferred — see deferred-items §2 #1). Empty is fine.
    const graphRanking: string[] = (graphRows ?? []).map((r: any) => String(r.id))

    // ── Reciprocal rank fusion ──
    const fusedIds = rrf([semanticRanking, keywordRanking, graphRanking], RRF_K, limit)
    if (fusedIds.length === 0) return []

    // Hydrate full records.
    const idsLit = "[" + fusedIds.map((id) => `memory:⟨${id}⟩`).join(",") + "]"
    const rows = await this.run(
      `SELECT meta::id(id) AS id, content, persona, scope, metadata, created_at, accessed_at
       FROM memory WHERE id IN ${idsLit};`,
    )
    const byId = new Map<string, any>()
    for (const r of rows) byId.set(String(r.id), r)

    const results: MemoryResult[] = []
    for (const id of fusedIds) {
      const r = byId.get(id)
      if (!r) continue
      results.push({
        id: String(r.id),
        content: String(r.content ?? ""),
        persona: String(r.persona ?? ""),
        scope: String(r.scope ?? ""),
        score: 0,
        source: "surreal" as const,
        metadata: (r.metadata as Record<string, unknown>) ?? {},
        created_at: String(r.created_at ?? ""),
        accessed_at: String(r.accessed_at ?? ""),
      })
    }
    const fusedScores = rrfScores([semanticRanking, keywordRanking, graphRanking], RRF_K)
    for (const r of results) (r as any).score = fusedScores.get(r.id) ?? 0
    return results
  }

  async forget(id: string): Promise<void> {
    if (!this.opened) throw new Error("SurrealBackend not initialized")

    // Delete mentions edges FROM this memory, then the memory itself.
    await this.run(`DELETE mentions WHERE in = memory:⟨${id}⟩;`)
    await this.run(`DELETE supersedes WHERE in = memory:⟨${id}⟩ OR out = memory:⟨${id}⟩;`)
    await this.run(`DELETE memory:⟨${id}⟩;`)
  }

  async list(persona: string, limit?: number): Promise<MemoryResult[]> {
    if (!this.opened) throw new Error("SurrealBackend not initialized")

    const lim = limit ?? 20
    const rows = await this.run(
      `SELECT meta::id(id) AS id, content, persona, scope, metadata, created_at, accessed_at
       FROM memory
       WHERE persona = "${escapeStr(persona)}"
       ORDER BY accessed_at DESC
       LIMIT ${lim};`,
    )

    return rows.map((r: any) => ({
      id: String(r.id),
      content: String(r.content ?? ""),
      persona: String(r.persona ?? ""),
      scope: String(r.scope ?? ""),
      score: 0,
      source: "surreal" as const,
      metadata: (r.metadata as Record<string, unknown>) ?? {},
      created_at: String(r.created_at ?? ""),
      accessed_at: String(r.accessed_at ?? ""),
    }))
  }

  async getPrunable(ttl_days: number): Promise<MemoryResult[]> {
    if (!this.opened) throw new Error("SurrealBackend not initialized")

    const cutoff = new Date(Date.now() - ttl_days * 24 * 60 * 60 * 1000).toISOString()
    const rows = await this.run(
      `SELECT meta::id(id) AS id, content, persona, scope, metadata, created_at, accessed_at, access_count
       FROM memory
       WHERE accessed_at < "${cutoff}"
       ORDER BY accessed_at ASC;`,
    )

    return rows.map((r: any) => ({
      id: String(r.id),
      content: String(r.content ?? ""),
      persona: String(r.persona ?? ""),
      scope: String(r.scope ?? ""),
      score: 0,
      source: "surreal" as const,
      metadata: (r.metadata as Record<string, unknown>) ?? {},
      created_at: String(r.created_at ?? ""),
      accessed_at: String(r.accessed_at ?? ""),
    }))
  }

  async metrics(): Promise<BackendMetrics> {
    if (!this.opened) throw new Error("SurrealBackend not initialized")
    const inst = await this.run(`SELECT count() AS c FROM memory WHERE scope = "instance" GROUP ALL;`)
    const proj = await this.run(`SELECT count() AS c FROM memory WHERE scope = "project" GROUP ALL;`)
    const glob = await this.run(`SELECT count() AS c FROM memory WHERE scope = "global" GROUP ALL;`)
    const ment = await this.run(`SELECT count() AS c FROM mentions GROUP ALL;`).catch(() => [] as any[])
    const rel = await this.run(`SELECT count() AS c FROM relates GROUP ALL;`).catch(() => [] as any[])
    const sup = await this.run(`SELECT count() AS c FROM supersedes GROUP ALL;`).catch(() => [] as any[])
    const num = (rows: any[]): number => Number(rows?.[0]?.c ?? 0)
    return {
      instance_count: num(inst),
      project_count: num(proj),
      global_count: num(glob),
      edge_count: num(ment) + num(rel) + num(sup),
    }
  }

  /**
   * Spec 16 §D-08 — One-shot migration from the legacy SQLite memory tables
   * (MemoryTopicsTable + GraphEntityTable + GraphEdgeTable) into Surreal.
   *
   * Idempotent: a marker file at ${Global.Path.data}/memory-migration-surreal.json
   * records completion and prevents re-runs. The original SQLite tables are
   * left intact as a rollback safety net (per the design boundary in
   * docs/260427_foxybear_spec-memory-backend-kuzu.md §"Boundaries").
   */
  async migrateFromSqlite(): Promise<MigrationReport> {
    if (!this.opened) throw new Error("SurrealBackend not initialized")
    const start = Date.now()

    const { Global } = await import("../global")
    const markerPath = path.join(Global.Path.data, "memory-migration-surreal.json")
    if (fs.existsSync(markerPath)) {
      log.info("migration already complete, skipping", { markerPath })
      return { memories: 0, entities: 0, edges: 0, duration_ms: 0, ran: false }
    }

    const { Database } = await import("../storage/db")
    const { MemoryTopicsTable, GraphEntityTable, GraphEdgeTable } = await import("./memory.sql")
    const { bufferToFloat32 } = await import("./memory")

    const rows = Database.use((db) => ({
      memories: db.select().from(MemoryTopicsTable).all(),
      entities: db.select().from(GraphEntityTable).all(),
      edges: db.select().from(GraphEdgeTable).all(),
    }))

    log.info("migrating from sqlite to surreal", {
      memories: rows.memories.length,
      entities: rows.entities.length,
      edges: rows.edges.length,
    })

    let memoryCount = 0
    for (const m of rows.memories) {
      const embedding = m.embedding instanceof Buffer ? bufferToFloat32(m.embedding) : new Float32Array(0)
      // Map legacy scope strings ("general", "session", etc.) to the new
      // {instance, project, global} taxonomy. "global" project_id stays
      // "global"; everything else is project-scoped.
      const scope: "instance" | "project" | "global" =
        m.project_id === "global" ? "global" : "project"
      try {
        await this.write({
          id: m.id,
          content: m.content,
          embedding,
          scope,
          project_id: m.project_id ?? undefined,
          persona: m.persona,
          metadata: (m.metadata as Record<string, unknown>) ?? {},
          created_at:
            (m as any).time_created != null
              ? new Date(Number((m as any).time_created)).toISOString()
              : new Date().toISOString(),
        })
        memoryCount++
      } catch (err) {
        log.warn("migration: skipped memory row", { id: m.id, error: String(err) })
      }
    }

    let entityCount = 0
    for (const e of rows.entities) {
      const embedding =
        e.embedding instanceof Buffer ? Array.from(bufferToFloat32(e.embedding)) : []
      const validFrom = new Date(Number(e.valid_from)).toISOString()
      const validTo = e.invalid_from != null ? new Date(Number(e.invalid_from)).toISOString() : ""
      const scope = e.project_id === "global" ? "global" : "project"
      const fields = {
        name: e.name,
        entity_type: e.entity_type,
        scope,
        project_id: e.project_id,
        embedding,
        metadata: e.metadata ?? {},
        valid_from: validFrom,
        valid_to: validTo,
      }
      try {
        await this.run(`CREATE entity:⟨${e.id}⟩ CONTENT ${JSON.stringify(fields)};`)
        entityCount++
      } catch (err) {
        log.warn("migration: skipped entity row", { id: e.id, error: String(err) })
      }
    }

    let edgeCount = 0
    for (const e of rows.edges) {
      const validFrom = new Date(Number(e.valid_from)).toISOString()
      const validTo = e.invalid_from != null ? new Date(Number(e.invalid_from)).toISOString() : ""
      try {
        await this.run(
          `RELATE entity:⟨${e.source_id}⟩->relates->entity:⟨${e.target_id}⟩
           SET id = "${escapeStr(e.id)}",
               relation = "${escapeStr(e.edge_type)}",
               weight = ${e.weight ?? 1.0},
               scope = "${e.project_id === "global" ? "global" : "project"}",
               project_id = "${escapeStr(e.project_id ?? "")}",
               source_project = "${escapeStr(e.source_project ?? "")}",
               valid_from = "${validFrom}",
               valid_to = "${validTo}";`,
        )
        edgeCount++
      } catch (err) {
        log.warn("migration: skipped edge row", { id: e.id, error: String(err) })
      }
    }

    const report: MigrationReport = {
      memories: memoryCount,
      entities: entityCount,
      edges: edgeCount,
      duration_ms: Date.now() - start,
      ran: true,
    }

    fs.mkdirSync(path.dirname(markerPath), { recursive: true })
    fs.writeFileSync(
      markerPath,
      JSON.stringify({ ...report, completed_at: new Date().toISOString() }, null, 2),
    )
    log.info("migration complete", report)
    return report
  }

  /**
   * Internal: run a SurrealQL statement, return the result rows.
   * SurrealDB's `db.query()` returns an array of result-sets (one per
   * statement); we unwrap to the rows of the first/last statement.
   *
   * If the query fails with an auth/permission error (stale WebSocket
   * session), re-authenticate once and retry.
   */
  async run(surql: string): Promise<any[]> {
    try {
      return this.unwrapQueryResult(await this.db.query(surql))
    } catch (err) {
      if (!this.isAuthError(err)) throw err
      log.warn("surreal auth expired, re-authenticating", { error: String(err) })
      await this.reauthenticate()
      return this.unwrapQueryResult(await this.db.query(surql))
    }
  }

  private unwrapQueryResult(out: unknown): any[] {
    if (!Array.isArray(out)) return []
    if (out.length === 1 && Array.isArray(out[0])) return out[0] as any[]
    const last = out[out.length - 1]
    return Array.isArray(last) ? (last as any[]) : []
  }

  private isAuthError(err: unknown): boolean {
    const msg = String(err).toLowerCase()
    return msg.includes("not enough permissions") || msg.includes("anonymous access")
  }

  private async reauthenticate(): Promise<void> {
    try {
      await this.db.signin({ username: this.username, password: this.password })
      await this.db.use({ namespace: this.namespace, database: this.database })
      log.info("surreal re-authenticated")
    } catch (reconnErr) {
      log.warn("surreal re-auth failed, reconnecting", { error: String(reconnErr) })
      const { Surreal } = await import("surrealdb")
      this.db = new Surreal()
      await this.db.connect(this.url)
      await this.db.signin({ username: this.username, password: this.password })
      await this.db.use({ namespace: this.namespace, database: this.database })
      log.info("surreal reconnected")
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function escapeStr(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1)
}

interface KeywordCandidate {
  id: string
  content: string
}

async function keywordCandidates(
  backend: SurrealBackend,
  tokens: string[],
  scopeClause: string,
  projectClause: string,
): Promise<KeywordCandidate[]> {
  // SurrealDB's CONTAINS works on string values. Build OR'd predicate.
  const clauses = tokens.map((t) => `content CONTAINS "${escapeStr(t)}"`)
  const where = `${scopeClause} ${projectClause} AND (${clauses.join(" OR ")})`
  const rows = await backend.run(
    `SELECT meta::id(id) AS id, content FROM memory WHERE ${where} LIMIT ${KEYWORD_LIMIT};`,
  )
  return rows.map((r: any) => ({ id: String(r.id), content: String(r.content ?? "") }))
}

/** BM25 ranker — Robertson-style with k1=1.2, b=0.75. */
function bm25Rank(queryTokens: string[], candidates: KeywordCandidate[]): { id: string; score: number }[] {
  if (candidates.length === 0) return []
  const k1 = 1.2
  const b = 0.75
  const docs = candidates.map((c) => ({ id: c.id, tokens: tokenize(c.content) }))
  const avgdl = docs.reduce((s, d) => s + d.tokens.length, 0) / docs.length
  const df = new Map<string, number>()
  for (const d of docs) {
    const seen = new Set<string>()
    for (const t of d.tokens) {
      if (queryTokens.includes(t) && !seen.has(t)) {
        df.set(t, (df.get(t) ?? 0) + 1)
        seen.add(t)
      }
    }
  }
  const N = docs.length
  const scored = docs.map((d) => {
    let score = 0
    const tf = new Map<string, number>()
    for (const t of d.tokens) {
      if (queryTokens.includes(t)) tf.set(t, (tf.get(t) ?? 0) + 1)
    }
    for (const t of queryTokens) {
      const dft = df.get(t) ?? 0
      if (dft === 0) continue
      const idf = Math.log(1 + (N - dft + 0.5) / (dft + 0.5))
      const f = tf.get(t) ?? 0
      const norm = (f * (k1 + 1)) / (f + k1 * (1 - b + b * (d.tokens.length / avgdl)))
      score += idf * norm
    }
    return { id: d.id, score }
  })
  scored.sort((a, b) => b.score - a.score)
  return scored.filter((s) => s.score > 0)
}

/** Reciprocal Rank Fusion. */
function rrf(rankings: string[][], k: number, limit: number): string[] {
  const scores = rrfScores(rankings, k)
  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id)
}

function rrfScores(rankings: string[][], k: number): Map<string, number> {
  const scores = new Map<string, number>()
  for (const ranking of rankings) {
    ranking.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1))
    })
  }
  return scores
}
