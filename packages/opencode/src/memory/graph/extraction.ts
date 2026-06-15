import type { EntityType, EdgeType } from "./types"

export interface ExtractedEntity {
  name: string
  type: EntityType
  content: string
}

export interface ExtractedRelationship {
  source_name: string
  target_name: string
  edge_type: EdgeType
  context: string
}

export interface ExtractionResult {
  entities: ExtractedEntity[]
  relationships: ExtractedRelationship[]
}

// Known tech terms for entity recognition
const KNOWN_TOOLS = new Set([
  "typescript", "javascript", "python", "rust", "go", "java", "kotlin", "swift", "dart",
  "react", "vue", "angular", "svelte", "solid", "next", "nuxt", "remix",
  "node", "bun", "deno", "express", "hono", "fastify",
  "drizzle", "prisma", "typeorm", "sequelize", "knex",
  "postgres", "postgresql", "mysql", "sqlite", "redis", "mongodb", "neo4j", "falkordb",
  "docker", "kubernetes", "terraform", "aws", "gcp", "azure",
  "git", "github", "gitlab", "bitbucket",
  "effect", "zod", "vitest", "jest", "playwright", "cypress",
  "flutter", "swiftui", "compose", "jetpack",
  "firebase", "supabase", "cloudflare",
  "graphql", "grpc", "rest", "openapi",
  "tailwind", "css", "sass",
])

// Decision patterns: "chose X over Y", "decided to use X", "went with X"
const DECISION_PATTERNS = [
  /\b(?:chose|choose|picked|selected)\s+(.+?)\s+over\s+(.+?)(?:\.|,|$)/gi,
  /\b(?:decided|going)\s+to\s+(?:use|go with)\s+(.+?)(?:\s+instead\s+of\s+(.+?))?(?:\.|,|$)/gi,
  /\b(?:went|going)\s+with\s+(.+?)(?:\s+(?:over|instead of)\s+(.+?))?(?:\.|,|$)/gi,
]

// Constraint patterns: "X doesn't work with Y", "X breaks Y"
const CONSTRAINT_PATTERNS = [
  /\b(.+?)\s+(?:doesn'?t|does not|won'?t|cannot|can'?t)\s+(?:work|compile|build|run)\s+(?:with|in|on|for)\s+(.+?)(?:\.|,|$)/gi,
  /\b(.+?)\s+(?:breaks|conflicts? with|incompatible with)\s+(.+?)(?:\.|,|$)/gi,
]

// Dependency patterns: "X requires Y", "X depends on Y"
const DEPENDENCY_PATTERNS = [
  /\b(.+?)\s+(?:requires?|depends? on|needs?)\s+(.+?)(?:\.|,|$)/gi,
  /\b(.+?)\s+(?:is built on|built with|uses)\s+(.+?)(?:\.|,|$)/gi,
]

function extractTechNames(content: string): string[] {
  const names: string[] = []
  const words = content.split(/[\s,;:()[\]{}'"]+/)
  for (const word of words) {
    const lower = word.toLowerCase().replace(/[.!?]$/, "")
    if (KNOWN_TOOLS.has(lower) && lower.length > 1) {
      names.push(word.replace(/[.!?]$/, ""))
    }
  }
  // Also find PascalCase terms (likely class/lib names)
  const pascalMatches = content.match(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g) || []
  for (const m of pascalMatches) {
    if (!names.includes(m)) names.push(m)
  }
  return [...new Set(names)]
}

function cleanName(raw: string): string {
  return raw.trim().replace(/^["'`]+|["'`]+$/g, "").trim().slice(0, 100)
}

export function extractEntitiesAndRelations(content: string): ExtractionResult {
  const entities: ExtractedEntity[] = []
  const relationships: ExtractedRelationship[] = []
  const seenNames = new Set<string>()

  function addEntity(name: string, type: EntityType, ctx: string): void {
    const clean = cleanName(name)
    if (!clean || clean.length < 2 || seenNames.has(clean.toLowerCase())) return
    seenNames.add(clean.toLowerCase())
    entities.push({ name: clean, type, content: ctx })
  }

  // Extract tech/tool names
  const techNames = extractTechNames(content)
  for (const name of techNames) {
    addEntity(name, "tool", content)
  }

  // Extract decisions (SUPERSEDES pattern)
  for (const pattern of DECISION_PATTERNS) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(content)) !== null) {
      const chosen = cleanName(match[1])
      const rejected = match[2] ? cleanName(match[2]) : undefined
      if (chosen) {
        addEntity(chosen, "decision", content)
        if (rejected) {
          addEntity(rejected, "decision", content)
          relationships.push({
            source_name: chosen,
            target_name: rejected,
            edge_type: "SUPERSEDES",
            context: match[0],
          })
        }
      }
    }
  }

  // Extract constraints (CONTRADICTS pattern)
  for (const pattern of CONSTRAINT_PATTERNS) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(content)) !== null) {
      const subjectName = cleanName(match[1])
      const objectName = cleanName(match[2])
      if (subjectName && objectName) {
        addEntity(subjectName, "constraint", content)
        addEntity(objectName, "constraint", content)
        relationships.push({
          source_name: subjectName,
          target_name: objectName,
          edge_type: "CONTRADICTS",
          context: match[0],
        })
      }
    }
  }

  // Extract dependencies (DEPENDS_ON pattern)
  for (const pattern of DEPENDENCY_PATTERNS) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(content)) !== null) {
      const subjectName = cleanName(match[1])
      const objectName = cleanName(match[2])
      if (subjectName && objectName) {
        addEntity(subjectName, "concept", content)
        addEntity(objectName, "concept", content)
        relationships.push({
          source_name: subjectName,
          target_name: objectName,
          edge_type: "DEPENDS_ON",
          context: match[0],
        })
      }
    }
  }

  // Co-occurrence: entities in the same content -> RELATES_TO
  if (entities.length >= 2) {
    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        // Only add co-occurrence if no explicit relationship exists
        const hasExplicit = relationships.some(
          (r) =>
            (r.source_name.toLowerCase() === entities[i].name.toLowerCase() &&
              r.target_name.toLowerCase() === entities[j].name.toLowerCase()) ||
            (r.source_name.toLowerCase() === entities[j].name.toLowerCase() &&
              r.target_name.toLowerCase() === entities[i].name.toLowerCase()),
        )
        if (!hasExplicit) {
          relationships.push({
            source_name: entities[i].name,
            target_name: entities[j].name,
            edge_type: "RELATES_TO",
            context: "co-occurrence",
          })
        }
      }
    }
  }

  return { entities, relationships }
}
