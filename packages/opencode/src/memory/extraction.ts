/**
 * Spec 16 §D / SG-03 — Pattern-based entity extractor.
 *
 * Source spec: docs/260427_foxybear_spec-surreal-graph-backend.md SG-03.
 *
 * Deterministic, idempotent, no LLM. Three entity types:
 *   - concept   : capitalized phrases ≥ 3 chars, NOT at sentence start
 *   - tool      : backtick-wrapped identifiers
 *   - pattern   : file-path-shaped tokens (e.g. src/memory/recall.ts)
 *
 * This module is intentionally narrower than `src/memory/graph/extraction.ts`,
 * which uses heuristic relationship-mining patterns (DECISION/CONSTRAINT/
 * DEPENDENCY) over a curated KNOWN_TOOLS list. SG-03 wants a small,
 * deterministic surface for the SurrealBackend write path; the legacy
 * extractor is preserved for the SQLite graph backend's existing callers.
 */
import type { EntityType } from "./graph/types"

export interface ExtractedEntity {
  /** Canonical name, also used as the lookup key against existing entities. */
  name: string
  entity_type: EntityType
}

const FILE_PATH_RE = /\b[a-z][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)+(?:\.[a-z0-9]+)?\b/g
const BACKTICK_RE = /`([^`\n]+?)`/g

// Sentence-end markers — used to recognize "start of sentence" capitalized
// tokens that must NOT be treated as concepts. A token is sentence-start if
// it sits at offset 0 or the previous non-whitespace character is `.`, `!`,
// or `?`.
function isSentenceStart(text: string, matchIndex: number): boolean {
  let i = matchIndex - 1
  while (i >= 0 && /\s/.test(text[i]!)) i--
  if (i < 0) return true
  const c = text[i]
  return c === "." || c === "!" || c === "?"
}

/**
 * Extract entities from the given text, deterministically and idempotently.
 * Order is stable: concepts (in document order), then tools, then patterns.
 * Duplicates are removed (case-sensitive equality on `name`).
 */
export function extractEntities(content: string): ExtractedEntity[] {
  if (!content) return []

  const seen = new Set<string>()
  const out: ExtractedEntity[] = []

  function add(entity: ExtractedEntity): void {
    const key = `${entity.entity_type}:${entity.name}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(entity)
  }

  // 1. Concepts — capitalized words ≥ 3 chars, NOT at sentence start.
  // Match runs of [A-Z][A-Za-z0-9]+ tokens. We deliberately want
  // CamelCase / PascalCase ("FoxyBear", "GraphBackend") to land in one match.
  const conceptRe = /\b[A-Z][A-Za-z0-9]{2,}\b/g
  let m: RegExpExecArray | null
  while ((m = conceptRe.exec(content)) !== null) {
    if (isSentenceStart(content, m.index)) continue
    add({ name: m[0], entity_type: "concept" })
  }

  // 2. Tools — anything inside backticks.
  while ((m = BACKTICK_RE.exec(content)) !== null) {
    const name = m[1]?.trim()
    if (!name) continue
    add({ name, entity_type: "tool" })
  }

  // 3. Patterns — file-path-shaped tokens.
  while ((m = FILE_PATH_RE.exec(content)) !== null) {
    add({ name: m[0], entity_type: "pattern" })
  }

  return out
}
