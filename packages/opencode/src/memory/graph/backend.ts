import type { GraphEntity, GraphEdge, GraphQueryResult, TraversalResult, EdgeType, EntityType } from "./types"

export interface EntityInput {
  project_id: string
  name: string
  entity_type: EntityType
  content: string
  embedding?: Float32Array
  metadata?: Record<string, unknown>
}

export interface EdgeInput {
  project_id: string
  source_id: string
  target_id: string
  edge_type: EdgeType
  weight?: number
  valid_from: number
  source_project?: string
  metadata?: Record<string, unknown>
}

export interface GraphBackend {
  init(): Promise<void>
  close(): Promise<void>
  healthy(): boolean

  // Entity operations
  upsertEntity(input: EntityInput): Promise<GraphEntity>
  getEntity(id: string): Promise<GraphEntity | undefined>
  findEntitiesByName(name: string, project_id: string): Promise<GraphEntity[]>
  searchEntities(input: {
    embedding: Float32Array
    project_id: string
    limit?: number
    include_global?: boolean
  }): Promise<Array<GraphEntity & { score: number }>>

  // Edge operations (bi-temporal)
  addEdge(input: EdgeInput): Promise<GraphEdge>
  invalidateEdge(id: string, invalid_from: number): Promise<void>
  getEdgesFrom(entity_id: string, opts?: { valid_only?: boolean }): Promise<GraphEdge[]>
  getEdgesTo(entity_id: string, opts?: { valid_only?: boolean }): Promise<GraphEdge[]>

  // Graph traversal
  traverse(input: {
    start_id: string
    max_hops: number
    edge_types?: EdgeType[]
    valid_only?: boolean
  }): Promise<TraversalResult[]>

  // Combined query (vector + graph)
  query(input: {
    project_id: string
    embedding?: Float32Array
    keyword?: string
    limit?: number
    include_global?: boolean
  }): Promise<GraphQueryResult>

  // Testing
  _reset(): Promise<void>
}
