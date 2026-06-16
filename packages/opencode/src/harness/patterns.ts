import { Database, eq } from "../storage/db"
import { ToolCallPatternsTable } from "./patterns.sql"
import { cosineSimilarity, float32ToBuffer, bufferToFloat32 } from "../memory/memory"
import { Log } from "../util/log"
import { ulid } from "ulid"
import { createHash } from "crypto"

const log = Log.create({ service: "harness.patterns" })

const READ_ONLY_TOOLS = new Set(["Read", "Glob", "Grep", "WebSearch"])

const MIN_FREQUENCY_FOR_MATCH = 3
const DEFAULT_MATCH_THRESHOLD = 0.85

export interface PatternEntry {
  id: string
  queryHash: string
  toolSequence: string[]
  frequency: number
  lastSeen: number
  avgLatencyMs: number
  deterministic: boolean
  projectId: string
  embedding?: Float32Array
}

export interface PrefetchResult {
  results: Array<{ tool: string; output: string }>
  staleness: string
}

function hashQuery(query: string): string {
  return createHash("sha256").update(query.trim().toLowerCase()).digest("hex")
}

export namespace ToolPatterns {
  export function logPattern(input: {
    query: string
    queryEmbedding?: Float32Array
    toolCalls: Array<{ name: string; latencyMs: number }>
    projectId?: string
  }): void {
    try {
      if (input.toolCalls.length === 0) return

      const queryHash = hashQuery(input.query)
      const toolSequence = input.toolCalls.map((t) => t.name)
      const totalLatency = input.toolCalls.reduce((sum, t) => sum + t.latencyMs, 0)
      const avgLatency = Math.round(totalLatency / input.toolCalls.length)
      const deterministic = input.toolCalls.every((t) => READ_ONLY_TOOLS.has(t.name))
      const projectId = input.projectId ?? "global"
      const embeddingBuf = input.queryEmbedding ? float32ToBuffer(input.queryEmbedding) : null

      const existing = Database.use((db) =>
        db
          .select()
          .from(ToolCallPatternsTable)
          .where(eq(ToolCallPatternsTable.query_hash, queryHash))
          .get(),
      )

      if (existing) {
        const oldFreq = existing.frequency ?? 1
        const oldAvg = existing.avg_latency_ms ?? avgLatency
        const newAvg = Math.round((oldAvg * oldFreq + avgLatency) / (oldFreq + 1))

        Database.use((db) => {
          db.update(ToolCallPatternsTable)
            .set({
              frequency: oldFreq + 1,
              avg_latency_ms: newAvg,
              last_seen: new Date(),
              tool_sequence: toolSequence as any,
              deterministic,
              ...(embeddingBuf ? { query_embedding: embeddingBuf } : {}),
            })
            .where(eq(ToolCallPatternsTable.id, existing.id))
            .run()
        })
      } else {
        const now = Date.now()
        Database.use((db) => {
          db.insert(ToolCallPatternsTable)
            .values({
              id: ulid(),
              query_hash: queryHash,
              query_embedding: embeddingBuf,
              tool_sequence: toolSequence as any,
              frequency: 1,
              last_seen: new Date(now),
              avg_latency_ms: avgLatency,
              deterministic,
              project_id: projectId,
              time_created: now,
              time_updated: now,
            })
            .run()
        })
      }
    } catch (err) {
      log.warn("pattern logging failed", { error: String(err) })
    }
  }

  export function findMatchingPattern(input: {
    queryEmbedding: Float32Array
    projectId?: string
    threshold?: number
  }): PatternEntry | null {
    const threshold = input.threshold ?? DEFAULT_MATCH_THRESHOLD

    try {
      const rows = Database.use((db) =>
        db
          .select()
          .from(ToolCallPatternsTable)
          .all(),
      )

      let bestMatch: PatternEntry | null = null
      let bestScore = 0

      for (const row of rows) {
        if (!row.query_embedding) continue
        if ((row.frequency ?? 0) < MIN_FREQUENCY_FOR_MATCH) continue
        if (input.projectId && row.project_id !== input.projectId && row.project_id !== "global") continue

        const emb = bufferToFloat32(row.query_embedding as Buffer)
        const score = cosineSimilarity(input.queryEmbedding, emb)

        if (score > bestScore && score >= threshold) {
          bestScore = score
          bestMatch = {
            id: row.id,
            queryHash: row.query_hash,
            toolSequence: (row.tool_sequence as string[]) ?? [],
            frequency: row.frequency ?? 1,
            lastSeen: row.last_seen ? new Date(row.last_seen as any).getTime() : 0,
            avgLatencyMs: row.avg_latency_ms ?? 0,
            deterministic: !!row.deterministic,
            projectId: row.project_id,
            embedding: emb,
          }
        }
      }

      return bestMatch
    } catch (err) {
      log.warn("pattern matching failed", { error: String(err) })
      return null
    }
  }

  export async function prefetch(_pattern: PatternEntry): Promise<PrefetchResult | null> {
    if (!_pattern.deterministic) return null
    return null
  }

  export function _reset(): void {
    try {
      Database.use((db) => {
        db.delete(ToolCallPatternsTable).run()
      })
    } catch {}
  }
}
