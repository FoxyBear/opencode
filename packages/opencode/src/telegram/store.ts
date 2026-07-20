import { eq } from "drizzle-orm"
import { Database } from "../storage/db"
import { TelegramSessionTable, type TelegramSessionRow, type JobModel } from "../queue/queue.sql"

// SDD-04: data-access over the shared `telegram_session` table (SC-1). This is
// the single storage home for a chat's durable session id, persona, and model
// override. SDD-01 (durable sessions) and SDD-02 (model_override) consume this
// module; none of them touches the table directly.
export namespace TelegramStore {
  export type Row = TelegramSessionRow

  export function getByChat(chatId: string): Row | undefined {
    return Database.use((db) =>
      db.select().from(TelegramSessionTable).where(eq(TelegramSessionTable.chat_id, chatId)).get(),
    )
  }

  export function getBySession(sessionId: string): Row | undefined {
    return Database.use((db) =>
      db.select().from(TelegramSessionTable).where(eq(TelegramSessionTable.session_id, sessionId)).get(),
    )
  }

  /**
   * Insert the chat row if absent, otherwise leave the existing row untouched.
   * Used by ingestion to guarantee a row exists before reading correlation.
   */
  export function upsert(chatId: string, fields?: { persona?: string; model_override?: string }): void {
    Database.use((db) => {
      db.insert(TelegramSessionTable)
        .values({
          chat_id: chatId,
          persona: fields?.persona ?? null,
          model_override: fields?.model_override ?? null,
        })
        .onConflictDoNothing()
        .run()
      if (fields && (fields.persona !== undefined || fields.model_override !== undefined)) {
        const set: Partial<Row> = {}
        if (fields.persona !== undefined) set.persona = fields.persona
        if (fields.model_override !== undefined) set.model_override = fields.model_override
        db.update(TelegramSessionTable).set(set).where(eq(TelegramSessionTable.chat_id, chatId)).run()
      }
    })
  }

  export function setSession(chatId: string, sessionId: string | null): void {
    Database.use((db) => {
      db.insert(TelegramSessionTable)
        .values({ chat_id: chatId, session_id: sessionId })
        .onConflictDoUpdate({ target: TelegramSessionTable.chat_id, set: { session_id: sessionId } })
        .run()
    })
  }

  /** `/new`: null the session id while preserving persona and model_override. */
  export function clearSession(chatId: string): void {
    setSession(chatId, null)
  }

  export function setModel(chatId: string, modelOverride: string | null): void {
    Database.use((db) => {
      db.insert(TelegramSessionTable)
        .values({ chat_id: chatId, model_override: modelOverride })
        .onConflictDoUpdate({ target: TelegramSessionTable.chat_id, set: { model_override: modelOverride } })
        .run()
    })
  }

  /** Parsed model override for the chat, or undefined when unset. */
  export function getModel(chatId: string): JobModel | undefined {
    const row = getByChat(chatId)
    return parseModel(row?.model_override ?? undefined)
  }

  /** Split a `provider/model` string into {providerID, modelID} (first slash). */
  export function parseModel(raw: string | undefined | null): JobModel | undefined {
    if (!raw) return undefined
    const idx = raw.indexOf("/")
    if (idx < 0) return undefined
    const providerID = raw.slice(0, idx)
    const modelID = raw.slice(idx + 1)
    if (!providerID || !modelID) return undefined
    return { providerID, modelID }
  }
}
