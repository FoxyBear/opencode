import { Database, eq, and, gte, or } from "../../storage/db"
import { MemoryTopicsTable } from "../memory.sql"
import { cosineSimilarity, bufferToFloat32 } from "../memory"
import { Embedding } from "../embedding"
import { extractEntitiesAndRelations } from "./extraction"
import { Log } from "../../util/log"
import type { GraphBackend } from "./backend"

const log = Log.create({ service: "graph.graduation" })

export interface GraduationResult {
  promoted: number
  entities_created: number
  edges_created: number
  contradictions_handled: number
  supersessions_handled: number
}

export async function graduateMemories(input: {
  project_id: string
  persona: string
  backend: GraphBackend
  embedding_config: Embedding.Config
}): Promise<GraduationResult> {
  const result: GraduationResult = {
    promoted: 0,
    entities_created: 0,
    edges_created: 0,
    contradictions_handled: 0,
    supersessions_handled: 0,
  }

  // Query instance memories eligible for graduation:
  // access_count >= 2 (validated by repeated access)
  const candidates = Database.use((db) =>
    db
      .select()
      .from(MemoryTopicsTable)
      .where(
        and(
          eq(MemoryTopicsTable.persona, input.persona),
          eq(MemoryTopicsTable.project_id, input.project_id),
          gte(MemoryTopicsTable.access_count, 2),
        ),
      )
      .all(),
  )

  if (candidates.length === 0) {
    log.info("graduation: no eligible memories", { project_id: input.project_id })
    return result
  }

  log.info("graduation: evaluating candidates", { count: candidates.length, project_id: input.project_id })

  for (const candidate of candidates) {
    try {
      const extraction = extractEntitiesAndRelations(candidate.content)
      if (extraction.entities.length === 0) continue

      // Create entity ID map for this candidate's extracted entities
      const entityIdMap = new Map<string, string>()

      for (const extracted of extraction.entities) {
        // Check if entity already exists in project graph
        const existing = await input.backend.findEntitiesByName(extracted.name, input.project_id)

        if (existing.length > 0) {
          // Entity exists — check for contradiction
          const existingEntity = existing[0]
          if (existingEntity.embedding && candidate.embedding) {
            const candidateEmb = bufferToFloat32(candidate.embedding as Buffer)
            const sim = cosineSimilarity(candidateEmb, existingEntity.embedding)
            if (sim < 0.3) {
              // Low similarity = likely contradiction
              // Invalidate old edges from this entity
              const oldEdges = await input.backend.getEdgesFrom(existingEntity.id)
              for (const edge of oldEdges) {
                await input.backend.invalidateEdge(edge.id, Date.now())
              }
              result.contradictions_handled++
            }
          }
          entityIdMap.set(extracted.name.toLowerCase(), existingEntity.id)
        } else {
          // New entity — create in project graph
          let embedding: Float32Array | undefined
          try {
            embedding = await Embedding.embed(extracted.content, input.embedding_config)
          } catch {}

          const entity = await input.backend.upsertEntity({
            project_id: input.project_id,
            name: extracted.name,
            entity_type: extracted.type,
            content: extracted.content,
            embedding,
          })
          entityIdMap.set(extracted.name.toLowerCase(), entity.id)
          result.entities_created++
        }
      }

      // Create relationships
      for (const rel of extraction.relationships) {
        const sourceId = entityIdMap.get(rel.source_name.toLowerCase())
        const targetId = entityIdMap.get(rel.target_name.toLowerCase())
        if (!sourceId || !targetId) continue

        await input.backend.addEdge({
          project_id: input.project_id,
          source_id: sourceId,
          target_id: targetId,
          edge_type: rel.edge_type,
          valid_from: Date.now(),
          metadata: { context: rel.context },
        })
        result.edges_created++

        if (rel.edge_type === "SUPERSEDES") result.supersessions_handled++
      }

      result.promoted++
    } catch (err) {
      log.warn("graduation: failed to process candidate", {
        memory_id: candidate.id,
        error: String(err),
      })
    }
  }

  log.info("graduation: complete", result)
  return result
}
