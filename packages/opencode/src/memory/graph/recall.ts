import { Memory, cosineSimilarity, type MemoryResult } from "../memory"
import { Log } from "../../util/log"
import type { GraphBackend } from "./backend"
import type { GraphEntity, GraphEdge } from "./types"

const log = Log.create({ service: "graph.recall" })

// Tier weight multipliers for ranking
const TIER_WEIGHT = {
  instance: 1.0,
  project: 0.9,
  global: 0.7,
} as const

const DEDUP_THRESHOLD = 0.9

export interface MultiTierRecallInput {
  query: string
  persona: string
  project_id: string
  embedding: Float32Array
  backend?: GraphBackend | null
  limit?: number
  include_global?: boolean
}

export interface MultiTierResult {
  instance: MemoryResult[]
  project: MemoryResult[]
  global: MemoryResult[]
  merged: MemoryResult[]
  degraded: boolean
}

function graphEntityToMemoryResult(
  entity: GraphEntity & { score: number },
  tier: "project" | "global",
  edges: GraphEdge[],
): MemoryResult {
  // Build relationship context annotations
  const annotations: string[] = []
  for (const edge of edges) {
    if (edge.source_id === entity.id) {
      if (edge.edge_type === "SUPERSEDES") annotations.push(`supersedes: ${edge.target_id}`)
      if (edge.edge_type === "CONTRADICTS") annotations.push(`contradicts: ${edge.target_id}`)
    }
  }

  const content = annotations.length > 0
    ? `${entity.content} (${annotations.join(", ")})`
    : entity.content

  return {
    id: entity.id,
    content,
    persona: "default",
    scope: tier,
    access_count: 0,
    created_at: String(entity.created_at),
    accessed_at: String(entity.updated_at),
    metadata: {
      entity_type: entity.entity_type,
      entity_name: entity.name,
      source_project: (entity as any).source_project,
      ...(entity.metadata ?? {}),
    },
    score: entity.score * TIER_WEIGHT[tier],
    source: tier as any,
  }
}

function isDuplicate(a: MemoryResult, b: MemoryResult): boolean {
  // Exact content match
  if (a.content === b.content) return true
  // Would need embeddings for cosine check — approximate by string overlap
  const shorter = a.content.length < b.content.length ? a.content : b.content
  const longer = a.content.length >= b.content.length ? a.content : b.content
  if (shorter.length > 20 && longer.includes(shorter)) return true
  return false
}

export async function multiTierRecall(input: MultiTierRecallInput): Promise<MultiTierResult> {
  const limit = input.limit ?? 10
  const includeGlobal = input.include_global !== false

  // Tier 1: Instance (always available)
  const instance = await Memory.searchLocalWithEmbedding({
    queryEmbedding: input.embedding,
    persona: input.persona,
    project_id: input.project_id,
    limit,
  })

  let project: MemoryResult[] = []
  let global: MemoryResult[] = []
  let degraded = false

  // Tier 2 + 3: Graph tiers (only if backend available)
  if (input.backend && input.backend.healthy()) {
    try {
      // Project tier
      const projectResult = await input.backend.query({
        project_id: input.project_id,
        embedding: input.embedding,
        limit,
        include_global: false,
      })
      project = projectResult.entities.map((e) =>
        graphEntityToMemoryResult(e, "project", projectResult.edges),
      )

      // Global tier
      if (includeGlobal) {
        const globalResult = await input.backend.query({
          project_id: "global",
          embedding: input.embedding,
          limit: Math.ceil(limit / 2),
          include_global: false,
        })
        global = globalResult.entities.map((e) =>
          graphEntityToMemoryResult(e, "global", globalResult.edges),
        )
      }
    } catch (err) {
      log.warn("multi-tier recall: graph query failed, degrading to instance only", {
        error: String(err),
      })
      degraded = true
    }
  } else {
    if (input.backend === undefined || input.backend === null) {
      degraded = true
    }
  }

  // Merge all tiers, dedup, rank
  const all = [...instance, ...project, ...global]
  const merged: MemoryResult[] = []

  for (const result of all) {
    const isDup = merged.some((existing) => isDuplicate(existing, result))
    if (!isDup) {
      merged.push(result)
    }
  }

  // Sort by score (tier weights already applied)
  merged.sort((a, b) => b.score - a.score)

  return {
    instance,
    project,
    global,
    merged: merged.slice(0, limit),
    degraded,
  }
}
