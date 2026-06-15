import z from "zod"
import { Effect } from "effect"
import { Tool } from "../tool/tool"
import { googleFetch } from "./api"

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me"

async function listAllMessageIds(query: string): Promise<Array<{ id: string; threadId: string }>> {
  const all: Array<{ id: string; threadId: string }> = []
  let pageToken: string | undefined
  do {
    const url = `${BASE}/messages?q=${encodeURIComponent(query)}&maxResults=500${pageToken ? `&pageToken=${pageToken}` : ""}`
    const data = await googleFetch(url)
    if (data.messages?.length) all.push(...data.messages)
    pageToken = data.nextPageToken
  } while (pageToken)
  return all
}

async function fetchMessageMetadata(id: string): Promise<string> {
  const msg = await googleFetch(
    `${BASE}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
  )
  const headers = msg.payload?.headers ?? []
  const get = (name: string) => headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ""
  const labels = (msg.labelIds ?? []) as string[]
  const flags = [labels.includes("UNREAD") ? "UNREAD" : null, labels.includes("IMPORTANT") ? "IMPORTANT" : null, labels.includes("STARRED") ? "STARRED" : null].filter(Boolean).join(", ")
  return `- **${get("Subject") || "(no subject)"}** from ${get("From")} (${get("Date")})${flags ? ` [${flags}]` : ""}\n  ID: ${id} | Snippet: ${msg.snippet?.slice(0, 120) ?? ""}`
}

export const GmailSearchTool = Tool.define(
  "gmail_search",
  Effect.succeed({
    description: "Search Gmail using Gmail API query syntax. Returns message summaries with metadata. Paginates to fetch ALL matching messages.",
    parameters: z.object({
      query: z.string().describe("Gmail search query (e.g., 'in:inbox', 'from:alice@example.com')"),
      max_results: z.number().optional().default(500).describe("Maximum results to return (default 500)"),
    }),
    execute: (params: { query: string; max_results: number }, _ctx: Tool.Context) =>
      Effect.promise(async () => {
        const allIds = await listAllMessageIds(params.query)
        if (!allIds.length) return { title: "No results", output: "No messages found.", metadata: { count: 0, shown: 0 } }

        const ids = allIds.slice(0, params.max_results)
        const summaries: string[] = []
        const BATCH = 20
        for (let i = 0; i < ids.length; i += BATCH) {
          const chunk = ids.slice(i, i + BATCH)
          const batch = await Promise.all(chunk.map((m) => fetchMessageMetadata(m.id)))
          summaries.push(...batch)
        }

        const total = allIds.length
        const shown = ids.length
        const title = total > shown ? `${shown} of ${total} messages` : `${total} messages`
        return { title, output: summaries.join("\n\n"), metadata: { count: total, shown } }
      }),
  }),
)

export const GmailReadTool = Tool.define(
  "gmail_read",
  Effect.succeed({
    description: "Read the full content of a Gmail message by ID.",
    parameters: z.object({
      message_id: z.string().describe("The Gmail message ID"),
    }),
    execute: (params: { message_id: string }, _ctx: Tool.Context) =>
      Effect.promise(async () => {
        const msg = await googleFetch(`${BASE}/messages/${params.message_id}?format=full`)
        const headers = msg.payload?.headers ?? []
        const get = (name: string) => headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ""

        let body = ""
        function extractText(part: any): void {
          if (part.mimeType === "text/plain" && part.body?.data) {
            body += Buffer.from(part.body.data, "base64url").toString("utf-8")
          } else if (part.parts) {
            part.parts.forEach(extractText)
          }
        }
        extractText(msg.payload)
        if (!body && msg.payload?.body?.data) {
          body = Buffer.from(msg.payload.body.data, "base64url").toString("utf-8")
        }

        const output = `From: ${get("From")}\nTo: ${get("To")}\nSubject: ${get("Subject")}\nDate: ${get("Date")}\n\n${body || "(no text body)"}`
        return { title: get("Subject") || "Message", output, metadata: { message_id: params.message_id } }
      }),
  }),
)

export const GmailCountTool = Tool.define(
  "gmail_count",
  Effect.succeed({
    description: "Count Gmail messages matching a query. Returns exact count by paginating all results.",
    parameters: z.object({
      query: z.string().optional().default("in:inbox").describe("Gmail search query (default: inbox)"),
    }),
    execute: (params: { query: string }, _ctx: Tool.Context) =>
      Effect.promise(async () => {
        const all = await listAllMessageIds(params.query)
        const count = all.length
        return { title: `${count} messages`, output: `${count} messages match "${params.query}"`, metadata: { count } }
      }),
  }),
)

export const GmailDraftTool = Tool.define(
  "gmail_draft",
  Effect.succeed({
    description: "Create a Gmail draft (does NOT send). Returns the draft ID.",
    parameters: z.object({
      to: z.string().describe("Recipient email address"),
      subject: z.string().describe("Email subject"),
      body: z.string().describe("Email body (plain text)"),
      cc: z.string().optional().describe("CC recipients (comma-separated)"),
      bcc: z.string().optional().describe("BCC recipients (comma-separated)"),
    }),
    execute: (params: { to: string; subject: string; body: string; cc?: string; bcc?: string }, _ctx: Tool.Context) =>
      Effect.promise(async () => {
        const headers = [`To: ${params.to}`, `Subject: ${params.subject}`]
        if (params.cc) headers.push(`Cc: ${params.cc}`)
        if (params.bcc) headers.push(`Bcc: ${params.bcc}`)
        const raw = Buffer.from(`${headers.join("\r\n")}\r\n\r\n${params.body}`).toString("base64url")

        const data = await googleFetch(`${BASE}/drafts`, {
          method: "POST",
          body: JSON.stringify({ message: { raw } }),
        })

        return { title: "Draft created", output: `Draft created with ID: ${data.id}`, metadata: { draft_id: data.id } }
      }),
  }),
)

export const GmailReplyTool = Tool.define(
  "gmail_reply",
  Effect.succeed({
    description: "Create a reply draft to an existing Gmail message, preserving the thread.",
    parameters: z.object({
      message_id: z.string().describe("The message ID to reply to"),
      body: z.string().describe("Reply body (plain text)"),
    }),
    execute: (params: { message_id: string; body: string }, _ctx: Tool.Context) =>
      Effect.promise(async () => {
        const original = await googleFetch(`${BASE}/messages/${params.message_id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Message-ID`)
        const headers = original.payload?.headers ?? []
        const get = (name: string) => headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ""

        const subject = get("Subject").startsWith("Re:") ? get("Subject") : `Re: ${get("Subject")}`
        const replyHeaders = [
          `To: ${get("From")}`,
          `Subject: ${subject}`,
          `In-Reply-To: ${get("Message-ID")}`,
          `References: ${get("Message-ID")}`,
        ]
        const raw = Buffer.from(`${replyHeaders.join("\r\n")}\r\n\r\n${params.body}`).toString("base64url")

        const data = await googleFetch(`${BASE}/drafts`, {
          method: "POST",
          body: JSON.stringify({ message: { raw, threadId: original.threadId } }),
        })

        return { title: "Reply draft created", output: `Reply draft created with ID: ${data.id}`, metadata: { draft_id: data.id } }
      }),
  }),
)

export const GmailArchiveTool = Tool.define(
  "gmail_archive",
  Effect.succeed({
    description: "Archive a Gmail message (remove from inbox, not delete).",
    parameters: z.object({
      message_id: z.string().describe("The message ID to archive"),
    }),
    execute: (params: { message_id: string }, _ctx: Tool.Context) =>
      Effect.promise(async () => {
        await googleFetch(`${BASE}/messages/${params.message_id}/modify`, {
          method: "POST",
          body: JSON.stringify({ removeLabelIds: ["INBOX"] }),
        })
        return { title: "Archived", output: `Message ${params.message_id} archived.`, metadata: { message_id: params.message_id } }
      }),
  }),
)
