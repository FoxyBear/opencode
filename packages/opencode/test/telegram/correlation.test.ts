import { describe, expect, test } from "bun:test"
import { TelegramCorrelation } from "../../src/telegram/correlation"
import { TelegramStore } from "../../src/telegram/store"
import { Queue } from "../../src/queue/queue"
import { Database } from "../../src/storage/db"
import { SessionTable } from "../../src/session/session.sql"
import { ProjectTable } from "../../src/project/project.sql"

// Unique-per-test ids so tests sharing the process-wide db do not collide.
let _seq = 0
function uid(): string {
  return `${Date.now()}-${_seq++}`
}

function insertProject(id: string): void {
  Database.use((db) =>
    db
      .insert(ProjectTable)
      .values({ id, worktree: "/tmp/" + id, sandboxes: [] } as any)
      .onConflictDoNothing()
      .run(),
  )
}

function insertSession(id: string, projectId: string, parentId?: string): void {
  Database.use((db) =>
    db
      .insert(SessionTable)
      .values({
        id,
        project_id: projectId,
        parent_id: parentId ?? null,
        slug: "s",
        directory: "/tmp",
        title: "t",
        version: "0",
      } as any)
      .run(),
  )
}

describe("TelegramCorrelation.resolveChatForSession (SDD-03 QR-3/QR-4/QR-12)", () => {
  test("direct telegram_session mapping resolves without a walk", () => {
    const chat = "chat-" + uid()
    const ses = "ses_" + uid()
    TelegramStore.setSession(chat, ses)
    expect(TelegramCorrelation.resolveChatForSession(ses)).toBe(chat)
  })

  test("child session resolves to the parent chat via parent_id walk (QR-3)", () => {
    const chat = "chat-" + uid()
    const project = "prj_" + uid()
    const parent = "ses_parent_" + uid()
    const child = "ses_child_" + uid()
    insertProject(project)
    insertSession(parent, project)
    insertSession(child, project, parent)
    // Only the parent carries the durable chat mapping.
    TelegramStore.setSession(chat, parent)

    expect(TelegramCorrelation.resolveChatForSession(child)).toBe(chat)
  })

  test("multi-hop child chain resolves to the top-level chat", () => {
    const chat = "chat-" + uid()
    const project = "prj_" + uid()
    const top = "ses_top_" + uid()
    const mid = "ses_mid_" + uid()
    const leaf = "ses_leaf_" + uid()
    insertProject(project)
    insertSession(top, project)
    insertSession(mid, project, top)
    insertSession(leaf, project, mid)
    TelegramStore.setSession(chat, top)

    expect(TelegramCorrelation.resolveChatForSession(leaf)).toBe(chat)
  })

  test("resolves via worker-persisted job_queue.session_id (QR-12)", () => {
    const chat = "chat-" + uid()
    const ses = "ses_job_" + uid()
    const jobId = Queue.enqueue({ kind: "chat_message", payload: { prompt: "x" }, chat_id: chat })
    Queue.setSession(jobId, ses)

    expect(TelegramCorrelation.resolveChatForSession(ses)).toBe(chat)
  })

  test("a session with no chat-owning ancestor yields undefined (QR-4)", () => {
    const project = "prj_" + uid()
    const orphan = "ses_orphan_" + uid()
    insertProject(project)
    insertSession(orphan, project)

    expect(TelegramCorrelation.resolveChatForSession(orphan)).toBeUndefined()
  })

  test("an entirely unknown session yields undefined and does not throw (QR-4)", () => {
    expect(TelegramCorrelation.resolveChatForSession("ses_nonexistent_" + uid())).toBeUndefined()
  })

  test("parent walk is bounded and cycle-safe", () => {
    const project = "prj_" + uid()
    const a = "ses_a_" + uid()
    const b = "ses_b_" + uid()
    insertProject(project)
    // parent_id has no FK, so a mutual cycle is representable and must not hang.
    insertSession(a, project, b)
    insertSession(b, project, a)

    expect(TelegramCorrelation.resolveChatForSession(a)).toBeUndefined()
  })
})

describe("Layer B is deleted (SDD-03 QR-11 / V-1)", () => {
  test("the Question global registry symbols are gone", async () => {
    const { Question } = await import("../../src/question")
    const Q = Question as any
    expect(Q.globalRegister).toBeUndefined()
    expect(Q.globalUnregister).toBeUndefined()
    expect(Q.globalList).toBeUndefined()
    expect(Q.globalReply).toBeUndefined()
    expect(Q.globalReject).toBeUndefined()
  })
})
