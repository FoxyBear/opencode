import { eq } from "drizzle-orm"
import { Database } from "../storage/db"
import { TelegramStore } from "./store"
import { JobQueueTable } from "../queue/queue.sql"
import { SessionTable } from "../session/session.sql"
import type { SessionID } from "../session/schema"

// SDD-03 QR-3/QR-12: durable, sub-session-aware chat correlation for the question
// bridge. Resolves the originating chat for a question's session by consulting
// the durable stores (telegram_session and job_queue.session_id) and, for
// child/sub-agent sessions with no direct mapping, walking SessionTable.parent_id
// upward to the chat-owning ancestor. Replaces the deleted in-heap _sessionToChat
// map. All reads use the process-global Database, so no instance context is
// required (mirrors the SDD-04 poller correlation reads).
export namespace TelegramCorrelation {
  // Bounded hop cap prevents cycles or an unbounded parent walk (QR-3).
  const MAX_HOPS = 8

  /**
   * Resolve the chat_id that owns `sessionID`, or undefined when no chat-owning
   * ancestor exists within the hop limit (scheduler/mesh origin — QR-4). Never
   * throws.
   */
  export function resolveChatForSession(sessionID: string): string | undefined {
    let current: string | undefined = sessionID
    let hops = 0
    const seen = new Set<string>()

    while (current && hops < MAX_HOPS) {
      if (seen.has(current)) break
      seen.add(current)

      const chatId = chatForSessionDirect(current)
      if (chatId) return chatId

      current = parentOf(current)
      hops++
    }
    return undefined
  }

  // Direct correlation for a single session id: the durable chat mapping first
  // (telegram_session), then the worker-persisted job seam (job_queue.session_id,
  // QR-12). Either resolving to the same chat is acceptable.
  function chatForSessionDirect(sessionID: string): string | undefined {
    const viaStore = TelegramStore.getBySession(sessionID)?.chat_id
    if (viaStore) return viaStore

    const viaJob = Database.use((db) =>
      db
        .select({ chat_id: JobQueueTable.chat_id })
        .from(JobQueueTable)
        .where(eq(JobQueueTable.session_id, sessionID))
        .get(),
    )
    return viaJob?.chat_id ?? undefined
  }

  // Parent session id (if any) via the session_parent_idx index, for the walk.
  function parentOf(sessionID: string): string | undefined {
    const row = Database.use((db) =>
      db
        .select({ parent_id: SessionTable.parent_id })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID as SessionID))
        .get(),
    )
    return row?.parent_id ?? undefined
  }
}
