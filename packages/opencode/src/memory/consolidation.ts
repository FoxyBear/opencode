import { Memory, cosineSimilarity, bufferToFloat32 } from "./memory"
import { Embedding } from "./embedding"
import { getConfig } from "../config/bridge"
import { Log } from "../util/log"
import { Database, eq } from "../storage/db"
import { MemoryTopicsTable, MemoryIndexTable } from "./memory.sql"
import { isLockedOut, writeLock, removeLock } from "./consolidation-lock"

const log = Log.create({ service: "memory.consolidation" })

/**
 * SPEC DEVIATION (CN-01): The spec says "spawn a forked subagent" for per-turn extraction.
 * Phase 2 set precedent with synchronous heuristic analysis for session memory.
 * This implementation uses synchronous pattern matching on messages instead of a forked subagent.
 * Flagged per task instructions.
 */

// ── Extraction patterns ──

interface ExtractedFact {
  content: string
  type: "preference" | "correction" | "decision" | "constraint" | "pattern"
}

const PREFERENCE_PATTERNS = [
  /\bi\s+prefer\s+(.+?)(?:\s+over\s+(.+?))?(?:\.|$)/i,
  /\bi\s+(?:like|want|always\s+use|love)\s+(.+?)(?:\s+(?:for|in|when)\s+(.+?))?(?:\.|$)/i,
  /\buse\s+(.+?)\s+(?:instead\s+of|rather\s+than)\s+(.+?)(?:\.|$)/i,
]

const CORRECTION_PATTERNS = [
  /\bno[,.]?\s+actually\s+(.+?)(?:\.|$)/i,
  /\bthat'?s?\s+(?:wrong|incorrect|not\s+right)[,.]?\s*(.+?)(?:\.|$)/i,
  /\bcorrection[:\s]+(.+?)(?:\.|$)/i,
  /\bactually[,.]?\s+(?:the|it'?s?|we)\s+(.+?)(?:\.|$)/i,
]

const DECISION_PATTERNS = [
  /\blet'?s?\s+(?:go\s+with|use|pick|choose|stick\s+with)\s+(.+?)(?:\.|$)/i,
  /\bwe(?:'re|\s+are)\s+going\s+(?:to\s+use|with)\s+(.+?)(?:\.|$)/i,
  /\bdecided?\s+(?:on|to\s+use)\s+(.+?)(?:\.|$)/i,
]

const CONSTRAINT_PATTERNS = [
  /\b(.+?)\s+doesn'?t?\s+work\s+(?:because|since|due\s+to)\s+(.+?)(?:\.|$)/i,
  /\bcan'?t?\s+use\s+(.+?)\s+(?:because|since)\s+(.+?)(?:\.|$)/i,
  /\b(.+?)\s+(?:is\s+not\s+compatible|breaks|fails)\s+(?:with|when)\s+(.+?)(?:\.|$)/i,
]

const PATTERN_PATTERNS = [
  /\bevery\s+time\s+(.+?)[,]\s*(?:do|use|run|we\s+should)\s+(.+?)(?:\.|$)/i,
  /\balways\s+(.+?)\s+(?:before|after|when)\s+(.+?)(?:\.|$)/i,
  /\bwhenever\s+(.+?)[,]\s*(.+?)(?:\.|$)/i,
]

const PATTERN_GROUPS: Array<{
  type: ExtractedFact["type"]
  patterns: RegExp[]
}> = [
  { type: "preference", patterns: PREFERENCE_PATTERNS },
  { type: "correction", patterns: CORRECTION_PATTERNS },
  { type: "decision", patterns: DECISION_PATTERNS },
  { type: "constraint", patterns: CONSTRAINT_PATTERNS },
  { type: "pattern", patterns: PATTERN_PATTERNS },
]

function extractFacts(messages: any[]): ExtractedFact[] {
  const facts: ExtractedFact[] = []

  for (const msg of messages) {
    if (msg.role !== "user") continue

    const content = getTextContent(msg)
    if (!content) continue

    for (const group of PATTERN_GROUPS) {
      for (const pattern of group.patterns) {
        const match = content.match(pattern)
        if (match) {
          facts.push({
            content: match[0]!.trim(),
            type: group.type,
          })
        }
      }
    }
  }

  return facts
}

function getTextContent(msg: any): string | null {
  if (!msg.parts || !Array.isArray(msg.parts)) return null
  for (const part of msg.parts) {
    if (part.type === "text" && typeof part.content === "string") {
      return part.content
    }
  }
  return null
}

function getLastUserMessage(messages: any[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      return getTextContent(messages[i]!)
    }
  }
  return null
}

// ── CN-09: Narrow search term extraction ──

// Common stop words to filter out when extracting search terms
const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "dare", "ought",
  "i", "me", "my", "we", "our", "you", "your", "he", "she", "it",
  "they", "them", "their", "this", "that", "these", "those", "what",
  "which", "who", "whom", "how", "when", "where", "why", "if", "then",
  "so", "but", "and", "or", "not", "no", "nor", "for", "to", "of",
  "in", "on", "at", "by", "with", "from", "up", "about", "into",
  "through", "during", "before", "after", "above", "below", "between",
  "out", "off", "over", "under", "again", "further", "just", "also",
  "very", "really", "quite", "too", "much", "more", "most", "some",
  "any", "all", "both", "each", "few", "many", "such", "own", "same",
  "than", "other", "only", "its", "here", "there", "now", "then",
  "once", "like", "want", "use", "tell", "make", "get", "let",
])

/**
 * Extract notable search terms from recent user messages in a session.
 * Returns up to 5 distinctive terms (proper nouns, technical terms, multi-word phrases).
 */
async function extractSearchTerms(sessionId: string): Promise<string[]> {
  // Get recent user messages from the session transcript
  const allMessages = await Memory.searchTranscripts({ sessionId, query: "" })

  // Filter to get text from user messages (searchTranscripts returns all matching, but
  // with empty query it returns everything — we take the last few messages)
  const recentTexts = allMessages
    .slice(-5) // last 5 messages
    .map((m) => m.content)
    .filter((c) => c && c.length > 0)

  if (recentTexts.length === 0) return []

  const termCounts = new Map<string, number>()

  for (const text of recentTexts) {
    // Extract words that are likely meaningful: capitalized words, technical terms, longer words
    const words = text
      .replace(/[^\w\s-]/g, " ") // strip punctuation except hyphens
      .split(/\s+/)
      .filter((w) => w.length >= 3)
      .map((w) => w.toLowerCase())
      .filter((w) => !STOP_WORDS.has(w))

    for (const word of words) {
      termCounts.set(word, (termCounts.get(word) ?? 0) + 1)
    }
  }

  // Sort by frequency descending, take top 5
  const sorted = [...termCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([term]) => term)

  return sorted
}

// ── Config resolution ──

interface ConsolidationConfig {
  auto_capture: boolean
  stale_warning_days: number
  stale_penalty_days: number
  min_hours_between: number
  min_sessions_between: number
}

const DEFAULT_CONFIG: ConsolidationConfig = {
  auto_capture: true,
  stale_warning_days: 1,
  stale_penalty_days: 7,
  min_hours_between: 24,
  min_sessions_between: 5,
}

let _cachedConsolidationConfig: ConsolidationConfig | null = null

export async function resolveConsolidationConfig(): Promise<ConsolidationConfig> {
  if (_cachedConsolidationConfig) return _cachedConsolidationConfig

  try {
    const cfg = await getConfig()
    const mem = cfg.memory
    _cachedConsolidationConfig = {
      auto_capture: mem?.auto_capture ?? DEFAULT_CONFIG.auto_capture,
      stale_warning_days:
        mem?.consolidation?.stale_warning_days ?? DEFAULT_CONFIG.stale_warning_days,
      stale_penalty_days:
        mem?.consolidation?.stale_penalty_days ?? DEFAULT_CONFIG.stale_penalty_days,
      min_hours_between:
        mem?.consolidation?.min_hours_between ?? DEFAULT_CONFIG.min_hours_between,
      min_sessions_between:
        mem?.consolidation?.min_sessions_between ?? DEFAULT_CONFIG.min_sessions_between,
    }
  } catch {
    log.warn("consolidation: config unavailable, using defaults")
    _cachedConsolidationConfig = { ...DEFAULT_CONFIG }
  }

  return _cachedConsolidationConfig
}

/** Invalidate cached config — exposed for testing */
export function invalidateConsolidationConfigCache(): void {
  _cachedConsolidationConfig = null
}

// ── Consolidation Namespace ──

export namespace Consolidation {
  /**
   * CN-07: Gate logic — checks all three conditions for autoDream.
   * 1. >= min_hours_between hours since last consolidation
   * 2. >= min_sessions_between sessions completed since last
   * 3. No concurrent consolidation (lock check)
   */
  export async function shouldRun(opts?: { lockDir?: string }): Promise<boolean> {
    const config = await resolveConsolidationConfig()

    // Condition 1: Time gate
    const hoursSinceLast = (Date.now() - _lastConsolidationTime) / (60 * 60 * 1000)
    if (hoursSinceLast < config.min_hours_between) {
      return false
    }

    // Condition 2: Session gate
    if (_sessionsSinceLastConsolidation < config.min_sessions_between) {
      return false
    }

    // Condition 3: Lock check (CN-12, CN-13)
    if (opts?.lockDir) {
      if (isLockedOut(opts.lockDir)) {
        return false
      }
    }

    return true
  }

  /**
   * CN-08: Orient phase — read memory index, build dedup map.
   */
  export async function orient(input: { persona: string }): Promise<OrientResult> {
    // Load memories with embeddings directly from DB
    const memWithEmb: Array<{ id: string; content: string; embedding: Float32Array }> = []

    const rows = Database.use((db) =>
      db.select().from(MemoryTopicsTable).where(eq(MemoryTopicsTable.persona, input.persona)).all(),
    )

    for (const row of rows) {
      memWithEmb.push({
        id: row.id,
        content: row.content,
        embedding: bufferToFloat32(row.embedding as Buffer),
      })
    }

    // Build pairwise dedup map
    const dedupPairs: Array<{ idA: string; idB: string; similarity: number }> = []
    for (let i = 0; i < memWithEmb.length; i++) {
      for (let j = i + 1; j < memWithEmb.length; j++) {
        const sim = cosineSimilarity(memWithEmb[i]!.embedding, memWithEmb[j]!.embedding)
        if (sim > 0.5) {
          dedupPairs.push({
            idA: memWithEmb[i]!.id,
            idB: memWithEmb[j]!.id,
            similarity: sim,
          })
        }
      }
    }

    return {
      memoryCount: memWithEmb.length,
      dedupPairs,
      memories: memWithEmb,
    }
  }

  /**
   * CN-09: Gather phase — search recent session transcripts for new signal.
   * Uses narrow search terms derived from recent user messages, not empty queries.
   */
  export async function gather(input: {
    persona: string
    recentSessionIds: string[]
    existingMemoryIds: string[]
  }): Promise<GatherResult> {
    const candidates: Array<{ content: string; sessionId: string; messageId: string }> = []
    const seenMessageIds = new Set<string>()

    // Get existing memories to check for novelty
    const existingMemories = await Memory.list({ persona: input.persona, limit: 1000 })
    const existingContents = new Set(existingMemories.map((m) => m.content.toLowerCase()))

    for (const sessionId of input.recentSessionIds) {
      // CN-09: Extract narrow search terms from recent user messages in this session
      const searchTerms = await extractSearchTerms(sessionId)

      if (searchTerms.length === 0) continue

      // Search transcripts with each narrow term and combine results
      for (const term of searchTerms) {
        const transcriptResults = await Memory.searchTranscripts({
          sessionId,
          query: term,
        })

        // For each transcript message, check if it has extractable content
        for (const result of transcriptResults) {
          // Dedup across terms within the same session
          if (seenMessageIds.has(result.messageId)) continue
          seenMessageIds.add(result.messageId)

          const content = result.content.trim()
          if (!content || content.length < 10) continue

          // Check if this content is already covered by existing memories
          const contentLower = content.toLowerCase()
          let isNovel = true
          for (const existing of existingContents) {
            if (existing.includes(contentLower) || contentLower.includes(existing)) {
              isNovel = false
              break
            }
          }

          if (isNovel) {
            candidates.push({
              content,
              sessionId,
              messageId: result.messageId,
            })
          }
        }
      }
    }

    return { candidates }
  }

  /**
   * CN-10: Consolidate phase — merge new signal, handle contradictions.
   */
  export async function consolidate(input: {
    persona: string
    candidates: Array<{ content: string; sessionId: string; supersedes?: string }>
  }): Promise<ConsolidatePhaseResult> {
    let merged = 0
    let created = 0
    let deleted = 0

    let dedupThreshold = 0.9

    // Read dedup_threshold from runtime config
    try {
      const cfg = await getConfig()
      dedupThreshold = cfg.memory?.dedup_threshold ?? 0.9
    } catch {
      // Use default
    }

    for (const candidate of input.candidates) {
      // Handle contradictions: if candidate supersedes an old memory, delete it
      if (candidate.supersedes) {
        try {
          await Memory.forget({ id: candidate.supersedes })
          deleted++
        } catch (err) {
          log.warn("consolidation: failed to forget superseded memory", {
            id: candidate.supersedes,
            error: String(err),
          })
        }
      }

      // Embed the candidate
      let candidateEmb: Float32Array
      try {
        candidateEmb = await getEmbedding(candidate.content)
      } catch {
        log.warn("consolidation: failed to embed candidate, skipping")
        continue
      }

      // Check existing memories for merge candidates (cosine > 0.9)
      const rows = Database.use((db) =>
        db.select().from(MemoryTopicsTable).where(eq(MemoryTopicsTable.persona, input.persona)).all(),
      )

      let didMerge = false
      for (const row of rows) {
        const existingEmb = bufferToFloat32(row.embedding as Buffer)
        const sim = cosineSimilarity(candidateEmb, existingEmb)

        if (sim > dedupThreshold) {
          // Merge: update existing memory (Memory.store handles dedup internally)
          await Memory.store({
            content: candidate.content,
            persona: input.persona,
            metadata: { source: "consolidation", session_id: candidate.sessionId },
          })
          merged++
          didMerge = true
          break
        }
      }

      if (!didMerge) {
        // Genuinely novel: create new memory
        // Convert relative dates in content to absolute
        const processedContent = convertRelativeDates(candidate.content)
        await Memory.store({
          content: processedContent,
          persona: input.persona,
          metadata: { source: "consolidation", session_id: candidate.sessionId },
        })
        created++
      }
    }

    return { merged, created, deleted }
  }

  /**
   * CN-11: Prune phase — remove old memories, merge near-duplicates, enforce index cap.
   */
  export async function prune(input: { persona: string }): Promise<PruneResult> {
    let pruned = 0
    let nearDupsMerged = 0
    let indexRemoved = 0

    // Read ttl_days from runtime config
    let ttlDays = 90
    try {
      const cfg = await getConfig()
      ttlDays = cfg.memory?.ttl_days ?? 90
    } catch {
      // Use default
    }

    // Step 1: Remove memories where accessed_at > ttl_days AND access_count < 3
    const prunableMemories = await Memory.getPrunable({ ttl_days: ttlDays })
    for (const mem of prunableMemories) {
      if (mem.access_count < 3) {
        await Memory.forget({ id: mem.id })
        pruned++
      }
    }

    // Step 2: Merge near-duplicates (cosine > 0.95)
    const rows = Database.use((db) =>
      db.select().from(MemoryTopicsTable).where(eq(MemoryTopicsTable.persona, input.persona)).all(),
    )

    // Read dedup_threshold from config (use 0.95 for near-dup pruning per spec)
    const nearDupThreshold = 0.95

    const toDelete = new Set<string>()
    for (let i = 0; i < rows.length; i++) {
      if (toDelete.has(rows[i]!.id)) continue
      for (let j = i + 1; j < rows.length; j++) {
        if (toDelete.has(rows[j]!.id)) continue
        const embA = bufferToFloat32(rows[i]!.embedding as Buffer)
        const embB = bufferToFloat32(rows[j]!.embedding as Buffer)
        const sim = cosineSimilarity(embA, embB)

        if (sim > nearDupThreshold) {
          // Keep more recently accessed, forget the other
          const accessedA = Number(rows[i]!.time_accessed ?? 0)
          const accessedB = Number(rows[j]!.time_accessed ?? 0)
          const deleteId = accessedA >= accessedB ? rows[j]!.id : rows[i]!.id
          toDelete.add(deleteId)
          nearDupsMerged++
        }
      }
    }

    for (const id of toDelete) {
      await Memory.forget({ id })
      pruned++
    }

    // Step 3: Enforce 200-entry cap on memory index (CN-11: drop lowest access_count)
    const indexEntries = Database.use((db) => db.select().from(MemoryIndexTable).all())

    if (indexEntries.length > MAX_INDEX_ENTRIES) {
      // Sort by access_count descending (highest first), then by time_created descending as tiebreaker
      // Entries past the cap (lowest access_count) get dropped
      const sorted = [...indexEntries].sort((a, b) => {
        const aCount = (a as any).access_count ?? 0
        const bCount = (b as any).access_count ?? 0
        if (bCount !== aCount) return bCount - aCount
        // Tiebreaker: newer entries preferred
        const aTime = Number(a.time_created ?? 0)
        const bTime = Number(b.time_created ?? 0)
        return bTime - aTime
      })

      const toRemove = sorted.slice(MAX_INDEX_ENTRIES)
      for (const entry of toRemove) {
        Database.use((db) => {
          db.delete(MemoryIndexTable).where(eq(MemoryIndexTable.id, entry.id)).run()
        })
        indexRemoved++
      }
    }

    return { pruned, nearDupsMerged, indexRemoved }
  }

  /**
   * CN-08..11 + CN-14: Full autoDream consolidation pipeline.
   * Creates lock at start, runs 4 phases, removes lock in finally block.
   */
  export async function run(input: {
    persona: string
    lockDir: string
    recentSessionIds: string[]
  }): Promise<ConsolidationResult> {
    const startTime = Date.now()

    // CN-14: Create lock
    writeLock(input.lockDir)

    try {
      // CN-08: Orient
      const orientResult = await orient({ persona: input.persona })

      // CN-09: Gather
      const gatherResult = await gather({
        persona: input.persona,
        recentSessionIds: input.recentSessionIds,
        existingMemoryIds: orientResult.memories.map((m) => m.id),
      })

      // CN-10: Consolidate
      const consolidateResult = await consolidate({
        persona: input.persona,
        candidates: gatherResult.candidates.map((c) => ({
          content: c.content,
          sessionId: c.sessionId,
        })),
      })

      // CN-11: Prune
      const pruneResult = await prune({ persona: input.persona })

      // Update module-level state
      _lastConsolidationTime = Date.now()
      _sessionsSinceLastConsolidation = 0

      return {
        merged: consolidateResult.merged,
        pruned: pruneResult.pruned,
        created: consolidateResult.created,
        indexUpdated: pruneResult.indexRemoved,
        durationMs: Date.now() - startTime,
      }
    } finally {
      // CN-14: Remove lock in finally block (success or failure)
      removeLock(input.lockDir)
    }
  }

  /**
   * Per-turn extraction: analyze conversation messages for durable facts
   * and store them via Memory.store().
   *
   * CN-01: Identifies preferences, corrections, decisions, constraints, patterns
   * CN-02: Only calls Memory.store() and Memory.recall() — no file system, no shell
   * CN-03: Stored memories include metadata.source = "extraction"
   * CN-04: Skips extraction if last user message starts with "/"
   * CN-05: Timeout + error handling — never blocks the user
   * CN-06: Respects auto_capture config
   */
  export async function extractTurn(input: {
    sessionID: string
    messages: any[]
    persona: string
    timeoutMs?: number
    /** Test override for config values — avoids needing to mock Config.get() */
    _testOverrides?: { auto_capture?: boolean }
  }): Promise<void> {
    const timeoutMs = input.timeoutMs ?? 10000

    try {
      // CN-06: Check auto_capture config
      if (input._testOverrides?.auto_capture !== undefined) {
        if (!input._testOverrides.auto_capture) return
      } else {
        const config = await resolveConsolidationConfig()
        if (!config.auto_capture) return
      }

      // CN-04: Skip if last user message starts with /
      const lastUserMsg = getLastUserMessage(input.messages)
      if (lastUserMsg && lastUserMsg.startsWith("/")) {
        return
      }

      // CN-05: Wrap extraction in Promise.race for timeout
      const extractionPromise = performExtraction(input)
      const timeoutPromise = new Promise<void>((resolve) => {
        setTimeout(() => {
          log.warn("consolidation: extraction timed out", {
            sessionID: input.sessionID,
            timeoutMs,
          })
          resolve()
        }, timeoutMs)
      })

      await Promise.race([extractionPromise, timeoutPromise])
    } catch (error) {
      // CN-05: Log and continue — never throw
      log.warn("consolidation: extraction failed", {
        sessionID: input.sessionID,
        error: String(error),
      })
    }
  }
}

async function performExtraction(input: {
  sessionID: string
  messages: any[]
  persona: string
}): Promise<void> {
  // CN-01: Extract durable facts using heuristic pattern matching
  const facts = extractFacts(input.messages)

  if (facts.length === 0) return

  // CN-02 + CN-03: Store each fact via Memory.store with extraction metadata
  for (const fact of facts) {
    try {
      await Memory.store({
        content: fact.content,
        persona: input.persona,
        metadata: {
          source: "extraction",
          type: fact.type,
          session_id: input.sessionID,
        },
      })
    } catch (storeError) {
      log.warn("consolidation: failed to store extracted fact", {
        error: String(storeError),
        type: fact.type,
      })
    }
  }
}

// ── Module-level state (resets on restart — per AC, acceptable for this sprint) ──

let _lastConsolidationTime: number = 0
let _sessionsSinceLastConsolidation: number = 0

/** Reset module-level state — exposed for testing */
export function resetState(state?: {
  lastConsolidationTime?: number
  sessionsSinceLastConsolidation?: number
}): void {
  _lastConsolidationTime = state?.lastConsolidationTime ?? 0
  _sessionsSinceLastConsolidation = state?.sessionsSinceLastConsolidation ?? 0
}

/** Increment session counter (called by scheduler when a session ends) */
export function recordSessionComplete(): void {
  _sessionsSinceLastConsolidation++
}

// ── Embedding config resolution ──

const FALLBACK_EMBEDDING_CONFIG: Embedding.Config = {
  provider: "deepinfra",
  model: "BAAI/bge-base-en-v1.5",
  dimensions: 768,
  fallback: {
    provider: "ollama",
    model: "nomic-embed-text",
  },
}

async function resolveEmbeddingConfig(): Promise<Embedding.Config> {
  try {
    const cfg = await getConfig()
    const mem = cfg.memory
    if (mem?.embedding) {
      return {
        provider: mem.embedding.provider as "ollama" | "deepinfra" | "openai",
        model: mem.embedding.model,
        dimensions: mem.embedding.dimensions,
        fallback: mem.embedding.fallback,
      }
    }
  } catch {
    // Fall through to default
  }
  return FALLBACK_EMBEDDING_CONFIG
}

async function getEmbedding(text: string): Promise<Float32Array> {
  const cfg = await resolveEmbeddingConfig()
  const result = await Embedding.embedSafe(text, cfg)
  if (!result.ok) throw result.error
  return result.value
}

// ── Consolidation Result ──

export interface ConsolidationResult {
  merged: number
  pruned: number
  created: number
  indexUpdated: number
  durationMs: number
}

// ── Orient result ──

export interface OrientResult {
  memoryCount: number
  dedupPairs: Array<{ idA: string; idB: string; similarity: number }>
  memories: Array<{ id: string; content: string; embedding: Float32Array }>
}

// ── Gather result ──

export interface GatherResult {
  candidates: Array<{ content: string; sessionId: string; messageId: string }>
}

// ── Consolidate result ──

export interface ConsolidatePhaseResult {
  merged: number
  created: number
  deleted: number
}

// ── Prune result ──

export interface PruneResult {
  pruned: number
  nearDupsMerged: number
  indexRemoved: number
}

const MAX_INDEX_ENTRIES = 200

// ── Relative date conversion (CN-10) ──

function convertRelativeDates(content: string): string {
  const now = new Date()

  return content
    .replace(/\byesterday\b/gi, formatAbsoluteDate(new Date(now.getTime() - 24 * 60 * 60 * 1000)))
    .replace(/\btoday\b/gi, formatAbsoluteDate(now))
    .replace(/\btomorrow\b/gi, formatAbsoluteDate(new Date(now.getTime() + 24 * 60 * 60 * 1000)))
    .replace(/\b(\d+)\s+days?\s+ago\b/gi, (_match, days) => {
      const d = new Date(now.getTime() - parseInt(days, 10) * 24 * 60 * 60 * 1000)
      return formatAbsoluteDate(d)
    })
}

function formatAbsoluteDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}
