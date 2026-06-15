import { cosineSimilarity } from "../memory"
import { Log } from "../../util/log"
import type { GraphBackend } from "./backend"
import type { GraphEntity } from "./types"

const log = Log.create({ service: "graph.promotion" })

const PROMOTION_MIN_CONNECTIONS = 3
const GLOBAL_DEDUP_THRESHOLD = 0.85

export interface GlobalPromotionResult {
  promoted: number
  entities_created: number
  edges_created: number
  skipped_duplicate: number
}

export async function promoteToGlobal(input: {
  project_id: string
  project_name: string
  backend: GraphBackend
}): Promise<GlobalPromotionResult> {
  const result: GlobalPromotionResult = {
    promoted: 0,
    entities_created: 0,
    edges_created: 0,
    skipped_duplicate: 0,
  }

  // Find high-value project entities (connected to >= N other entities)
  const projectEntities = await input.backend.searchEntities({
    // Use a zero embedding to get all entities (score won't matter, we filter by connections)
    embedding: new Float32Array(768),
    project_id: input.project_id,
    limit: 100,
    include_global: false,
  })

  for (const entity of projectEntities) {
    const edges = await input.backend.getEdgesFrom(entity.id)
    const inEdges = await input.backend.getEdgesTo(entity.id)
    const connectionCount = edges.length + inEdges.length

    if (connectionCount < PROMOTION_MIN_CONNECTIONS) continue

    // Check if a similar entity already exists in global scope
    if (entity.embedding) {
      const globalMatches = await input.backend.searchEntities({
        embedding: entity.embedding,
        project_id: "global",
        limit: 1,
        include_global: false,
      })

      if (globalMatches.length > 0 && globalMatches[0].score > GLOBAL_DEDUP_THRESHOLD) {
        result.skipped_duplicate++
        continue
      }
    }

    // Promote to global scope with provenance
    const globalEntity = await input.backend.upsertEntity({
      project_id: "global",
      name: entity.name,
      entity_type: entity.entity_type,
      content: entity.content,
      embedding: entity.embedding,
      metadata: {
        ...(entity.metadata ?? {}),
        source_project: input.project_name,
        promoted_from: input.project_id,
      },
    })
    result.entities_created++

    // Copy relevant edges to global scope
    for (const edge of edges) {
      // Only promote SUPERSEDES and CONTRADICTS edges — they carry important semantic info
      if (edge.edge_type === "SUPERSEDES" || edge.edge_type === "CONTRADICTS") {
        await input.backend.addEdge({
          project_id: "global",
          source_id: globalEntity.id,
          target_id: edge.target_id,
          edge_type: edge.edge_type,
          valid_from: Date.now(),
          source_project: input.project_name,
        })
        result.edges_created++
      }
    }

    result.promoted++
  }

  if (result.promoted > 0) {
    log.info("global promotion complete", { ...result, project: input.project_name })
  }

  return result
}
