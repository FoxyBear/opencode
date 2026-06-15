import type { GraphBackend, EntityInput, EdgeInput } from "./backend"
import type { GraphEntity, GraphEdge, GraphQueryResult, TraversalResult, EdgeType } from "./types"

/**
 * Neo4j graph backend — stub implementation.
 * Install `neo4j-driver` and implement when deploying with external Neo4j.
 */
export class Neo4jGraphBackend implements GraphBackend {
  async init(): Promise<void> {
    throw new Error("Neo4j backend not configured. Install neo4j-driver and configure memory.neo4j in foxybear.json")
  }

  async close(): Promise<void> {}
  healthy(): boolean { return false }

  async upsertEntity(_input: EntityInput): Promise<GraphEntity> { throw this.notConfigured() }
  async getEntity(_id: string): Promise<GraphEntity | undefined> { throw this.notConfigured() }
  async findEntitiesByName(_name: string, _project_id: string): Promise<GraphEntity[]> { throw this.notConfigured() }
  async searchEntities(_input: { embedding: Float32Array; project_id: string; limit?: number; include_global?: boolean }): Promise<Array<GraphEntity & { score: number }>> { throw this.notConfigured() }
  async addEdge(_input: EdgeInput): Promise<GraphEdge> { throw this.notConfigured() }
  async invalidateEdge(_id: string, _invalid_from: number): Promise<void> { throw this.notConfigured() }
  async getEdgesFrom(_entity_id: string, _opts?: { valid_only?: boolean }): Promise<GraphEdge[]> { throw this.notConfigured() }
  async getEdgesTo(_entity_id: string, _opts?: { valid_only?: boolean }): Promise<GraphEdge[]> { throw this.notConfigured() }
  async traverse(_input: { start_id: string; max_hops: number; edge_types?: EdgeType[]; valid_only?: boolean }): Promise<TraversalResult[]> { throw this.notConfigured() }
  async query(_input: { project_id: string; embedding?: Float32Array; keyword?: string; limit?: number; include_global?: boolean }): Promise<GraphQueryResult> { throw this.notConfigured() }
  async _reset(): Promise<void> {}

  private notConfigured(): Error {
    return new Error("Neo4j backend not configured")
  }
}
