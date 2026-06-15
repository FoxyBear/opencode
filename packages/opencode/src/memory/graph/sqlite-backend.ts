import { Database, eq, and, isNull, or, sql } from "../../storage/db"
import { GraphEntityTable, GraphEdgeTable } from "../memory.sql"
import { cosineSimilarity, float32ToBuffer, bufferToFloat32 } from "../memory"
import { Log } from "../../util/log"
import { ulid } from "ulid"
import type { GraphBackend, EntityInput, EdgeInput } from "./backend"
import type { GraphEntity, GraphEdge, GraphQueryResult, TraversalResult, EdgeType } from "./types"

const log = Log.create({ service: "graph.sqlite" })

function entityFromRow(row: any): GraphEntity {
  return {
    id: row.id,
    project_id: row.project_id,
    name: row.name,
    entity_type: row.entity_type,
    content: row.content,
    embedding: row.embedding ? bufferToFloat32(row.embedding as Buffer) : undefined,
    metadata: row.metadata as Record<string, unknown> | undefined,
    valid_from: row.valid_from,
    invalid_from: row.invalid_from ?? undefined,
    created_at: row.time_created,
    updated_at: row.time_updated,
  }
}

function edgeFromRow(row: any): GraphEdge {
  return {
    id: row.id,
    project_id: row.project_id,
    source_id: row.source_id,
    target_id: row.target_id,
    edge_type: row.edge_type as EdgeType,
    weight: row.weight ?? 1.0,
    valid_from: row.valid_from,
    invalid_from: row.invalid_from ?? undefined,
    source_project: row.source_project ?? undefined,
    metadata: row.metadata as Record<string, unknown> | undefined,
    created_at: row.time_created,
    updated_at: row.time_updated,
  }
}

export class SqliteGraphBackend implements GraphBackend {
  private _healthy = false

  async init(): Promise<void> {
    // Tables are created by migration. Just verify they exist.
    try {
      Database.use((db) => {
        db.select().from(GraphEntityTable).limit(1).all()
        db.select().from(GraphEdgeTable).limit(1).all()
      })
      this._healthy = true
      log.info("SQLite graph backend initialized")
    } catch (err) {
      this._healthy = false
      throw new Error(`SQLite graph backend init failed: ${err}`)
    }
  }

  async close(): Promise<void> {
    this._healthy = false
    log.info("SQLite graph backend closed")
  }

  healthy(): boolean {
    return this._healthy
  }

  async upsertEntity(input: EntityInput): Promise<GraphEntity> {
    const now = Date.now()
    const id = ulid()
    const embeddingBuf = input.embedding ? float32ToBuffer(input.embedding) : null

    Database.use((db) => {
      db.insert(GraphEntityTable)
        .values({
          id,
          project_id: input.project_id,
          name: input.name,
          entity_type: input.entity_type,
          content: input.content,
          embedding: embeddingBuf,
          metadata: input.metadata as any,
          valid_from: now,
          time_created: now,
          time_updated: now,
        })
        .run()
    })

    return {
      id,
      project_id: input.project_id,
      name: input.name,
      entity_type: input.entity_type as any,
      content: input.content,
      embedding: input.embedding,
      metadata: input.metadata,
      valid_from: now,
      created_at: now,
      updated_at: now,
    }
  }

  async getEntity(id: string): Promise<GraphEntity | undefined> {
    const row = Database.use((db) =>
      db.select().from(GraphEntityTable).where(eq(GraphEntityTable.id, id)).get(),
    )
    return row ? entityFromRow(row) : undefined
  }

  async findEntitiesByName(name: string, project_id: string): Promise<GraphEntity[]> {
    const rows = Database.use((db) =>
      db
        .select()
        .from(GraphEntityTable)
        .where(
          and(
            eq(GraphEntityTable.name, name),
            eq(GraphEntityTable.project_id, project_id),
            isNull(GraphEntityTable.invalid_from),
          ),
        )
        .all(),
    )
    return rows.map(entityFromRow)
  }

  async searchEntities(input: {
    embedding: Float32Array
    project_id: string
    limit?: number
    include_global?: boolean
  }): Promise<Array<GraphEntity & { score: number }>> {
    const limit = input.limit ?? 10
    const rows = Database.use((db) => {
      if (input.include_global) {
        return db
          .select()
          .from(GraphEntityTable)
          .where(
            and(
              or(
                eq(GraphEntityTable.project_id, input.project_id),
                eq(GraphEntityTable.project_id, "global"),
              ),
              isNull(GraphEntityTable.invalid_from),
            ),
          )
          .all()
      }
      return db
        .select()
        .from(GraphEntityTable)
        .where(
          and(
            eq(GraphEntityTable.project_id, input.project_id),
            isNull(GraphEntityTable.invalid_from),
          ),
        )
        .all()
    })

    const scored = rows
      .filter((r) => r.embedding)
      .map((row) => {
        const emb = bufferToFloat32(row.embedding as Buffer)
        const score = cosineSimilarity(input.embedding, emb)
        return { ...entityFromRow(row), score }
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)

    return scored
  }

  async addEdge(input: EdgeInput): Promise<GraphEdge> {
    const now = Date.now()
    const id = ulid()

    Database.use((db) => {
      db.insert(GraphEdgeTable)
        .values({
          id,
          project_id: input.project_id,
          source_id: input.source_id,
          target_id: input.target_id,
          edge_type: input.edge_type,
          weight: input.weight ?? 1.0,
          valid_from: input.valid_from,
          source_project: input.source_project,
          metadata: input.metadata as any,
          time_created: now,
          time_updated: now,
        })
        .run()
    })

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
    Database.use((db) => {
      db.update(GraphEdgeTable)
        .set({ invalid_from, time_updated: Date.now() })
        .where(eq(GraphEdgeTable.id, id))
        .run()
    })
  }

  async getEdgesFrom(entity_id: string, opts?: { valid_only?: boolean }): Promise<GraphEdge[]> {
    const rows = Database.use((db) => {
      const conditions = [eq(GraphEdgeTable.source_id, entity_id)]
      if (opts?.valid_only !== false) {
        conditions.push(isNull(GraphEdgeTable.invalid_from))
      }
      return db
        .select()
        .from(GraphEdgeTable)
        .where(and(...conditions))
        .all()
    })
    return rows.map(edgeFromRow)
  }

  async getEdgesTo(entity_id: string, opts?: { valid_only?: boolean }): Promise<GraphEdge[]> {
    const rows = Database.use((db) => {
      const conditions = [eq(GraphEdgeTable.target_id, entity_id)]
      if (opts?.valid_only !== false) {
        conditions.push(isNull(GraphEdgeTable.invalid_from))
      }
      return db
        .select()
        .from(GraphEdgeTable)
        .where(and(...conditions))
        .all()
    })
    return rows.map(edgeFromRow)
  }

  async traverse(input: {
    start_id: string
    max_hops: number
    edge_types?: EdgeType[]
    valid_only?: boolean
  }): Promise<TraversalResult[]> {
    const validOnly = input.valid_only !== false
    const maxHops = Math.min(input.max_hops, 3)

    // BFS traversal using iterative queries (SQLite recursive CTEs through raw SQL)
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
    const limit = input.limit ?? 10
    let entities: Array<GraphEntity & { score: number }> = []

    // Vector search
    if (input.embedding) {
      entities = await this.searchEntities({
        embedding: input.embedding,
        project_id: input.project_id,
        limit,
        include_global: input.include_global,
      })
    }

    // Keyword search (supplement vector results)
    if (input.keyword) {
      const keyword = `%${input.keyword.toLowerCase()}%`
      const rows = Database.use((db) => {
        const conditions = [
          isNull(GraphEntityTable.invalid_from),
          sql`lower(${GraphEntityTable.content}) LIKE ${keyword}`,
        ]
        if (input.include_global) {
          conditions.push(
            or(
              eq(GraphEntityTable.project_id, input.project_id),
              eq(GraphEntityTable.project_id, "global"),
            )!,
          )
        } else {
          conditions.push(eq(GraphEntityTable.project_id, input.project_id))
        }
        return db
          .select()
          .from(GraphEntityTable)
          .where(and(...conditions))
          .limit(limit)
          .all()
      })

      const keywordEntities = rows.map((r) => ({ ...entityFromRow(r), score: 0.5 }))
      // Merge keyword results, avoiding duplicates
      const existingIds = new Set(entities.map((e) => e.id))
      for (const ke of keywordEntities) {
        if (!existingIds.has(ke.id)) {
          entities.push(ke)
          existingIds.add(ke.id)
        }
      }
    }

    // Sort by score, limit
    entities = entities.sort((a, b) => b.score - a.score).slice(0, limit)

    // Get edges for found entities
    const entityIds = new Set(entities.map((e) => e.id))
    const edges: GraphEdge[] = []
    for (const entity of entities) {
      const outEdges = await this.getEdgesFrom(entity.id)
      for (const edge of outEdges) {
        if (entityIds.has(edge.target_id) || edge.edge_type === "SUPERSEDES" || edge.edge_type === "CONTRADICTS") {
          edges.push(edge)
        }
      }
    }

    return { entities, edges }
  }

  async _reset(): Promise<void> {
    Database.use((db) => {
      db.delete(GraphEdgeTable).run()
      db.delete(GraphEntityTable).run()
    })
    this._healthy = true
  }
}
