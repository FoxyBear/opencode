export type EntityType = "concept" | "tool" | "pattern" | "person" | "decision" | "constraint"

export type EdgeType = "RELATES_TO" | "DEPENDS_ON" | "SUPERSEDES" | "CONTRADICTS" | "PART_OF" | "USED_WITH"

export interface GraphEntity {
  id: string
  project_id: string
  name: string
  entity_type: EntityType
  content: string
  embedding?: Float32Array
  metadata?: Record<string, unknown>
  valid_from: number
  invalid_from?: number
  created_at: number
  updated_at: number
}

export interface GraphEdge {
  id: string
  project_id: string
  source_id: string
  target_id: string
  edge_type: EdgeType
  weight: number
  valid_from: number
  invalid_from?: number
  source_project?: string
  metadata?: Record<string, unknown>
  created_at: number
  updated_at: number
}

export interface TraversalResult {
  entity: GraphEntity
  depth: number
}

export interface GraphQueryResult {
  entities: Array<GraphEntity & { score: number }>
  edges: GraphEdge[]
}
