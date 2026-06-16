import z from "zod"
import { Effect } from "effect"
import { Tool } from "../tool/tool"
import { googleFetch } from "./api"

const BASE = "https://chat.googleapis.com/v1"

export const ChatSpacesTool = Tool.define(
  "chat_spaces",
  Effect.succeed({
    description: "List Google Chat spaces (rooms, DMs, group conversations) the user is a member of.",
    parameters: z.object({
      filter: z.string().optional().describe("Optional filter (e.g., 'spaceType = \"SPACE\"' for rooms only)"),
      max_results: z.number().optional().default(20).describe("Maximum spaces to return"),
    }),
    execute: (params: { filter?: string; max_results: number }, _ctx: Tool.Context) =>
      Effect.promise(async () => {
        const qs = new URLSearchParams({ pageSize: String(Math.min(params.max_results, 100)) })
        if (params.filter) qs.set("filter", params.filter)

        const data = await googleFetch(`${BASE}/spaces?${qs}`)
        const spaces = data.spaces ?? []

        if (spaces.length === 0) {
          return { title: "No spaces", output: "No Google Chat spaces found.", metadata: { count: 0 } }
        }

        const lines = spaces.map((s: any) => {
          const type = s.spaceType ?? s.type ?? "UNKNOWN"
          const memberCount = s.membershipCount ?? "?"
          return `- **${s.displayName || "(DM)"}** [${type}] — ${memberCount} members\n  Name: ${s.name}`
        })

        return { title: `${spaces.length} spaces`, output: lines.join("\n\n"), metadata: { count: spaces.length } }
      }),
  }),
)

export const ChatReadTool = Tool.define(
  "chat_read",
  Effect.succeed({
    description: "Read recent messages from a Google Chat space. Use chat_spaces to find space names first.",
    parameters: z.object({
      space: z.string().describe("Space resource name (e.g., 'spaces/AAAA...')"),
      max_results: z.number().optional().default(10).describe("Maximum messages to return"),
    }),
    execute: (params: { space: string; max_results: number }, _ctx: Tool.Context) =>
      Effect.promise(async () => {
        const raw = params.space.trim()
        const spaceId = raw.startsWith("spaces/") ? raw.slice(7) : raw
        if (!spaceId) {
          return { title: "Error", output: "Space name is required. Use chat_spaces to find space names first.", metadata: { count: 0 } }
        }
        const limit = Math.min(params.max_results, 25)
        const space = `spaces/${spaceId}`
        const data = await googleFetch(`${BASE}/${space}/messages?pageSize=${limit}&orderBy=createTime desc`)
        const messages = data.messages ?? []

        if (messages.length === 0) {
          return { title: "No messages", output: "No messages in this space.", metadata: { count: 0 } }
        }

        const lines = messages.map((m: any) => {
          const sender = m.sender?.displayName ?? m.sender?.name ?? "Unknown"
          const time = m.createTime ?? ""
          const text = m.text ?? m.formattedText ?? "(no text)"
          return `- **${sender}** (${time})\n  ${text.slice(0, 500)}\n  ID: ${m.name}`
        })

        return { title: `${messages.length} messages`, output: lines.join("\n\n"), metadata: { count: messages.length } }
      }),
  }),
)

export const ChatSendTool = Tool.define(
  "chat_send",
  Effect.succeed({
    description: "Send a message to a Google Chat space.",
    parameters: z.object({
      space: z.string().describe("Space resource name (e.g., 'spaces/AAAA...')"),
      text: z.string().describe("Message text to send"),
    }),
    execute: (params: { space: string; text: string }, _ctx: Tool.Context) =>
      Effect.promise(async () => {
        const space = params.space.startsWith("spaces/") ? params.space : `spaces/${params.space}`
        const data = await googleFetch(`${BASE}/${space}/messages`, {
          method: "POST",
          body: JSON.stringify({ text: params.text }),
        })

        return {
          title: "Message sent",
          output: `Message sent to ${space}. ID: ${data.name}`,
          metadata: { message_name: data.name },
        }
      }),
  }),
)
