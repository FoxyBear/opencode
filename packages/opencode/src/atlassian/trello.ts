import z from "zod"
import { Effect } from "effect"
import { Tool } from "../tool/tool"
import { trelloFetch } from "./api"

export const TrelloBoardsTool = Tool.define(
  "trello_boards",
  Effect.succeed({
    description: "List Trello boards the user is a member of.",
    parameters: z.object({
      filter: z.enum(["all", "open", "closed", "starred"]).optional().default("open").describe("Board filter"),
    }),
    execute: (params: { filter: "all" | "open" | "closed" | "starred" }, _ctx: Tool.Context) =>
      Effect.promise(async () => {
        const boards = await trelloFetch(`/members/me/boards?filter=${params.filter}&fields=name,shortUrl,closed,starred,dateLastActivity`)

        if (!boards?.length) {
          return { title: "No boards", output: "No Trello boards found.", metadata: { count: 0 } }
        }

        const lines = boards.map((b: any) => {
          const flags = [b.starred ? "starred" : "", b.closed ? "closed" : ""].filter(Boolean).join(", ")
          return `- **${b.name}**${flags ? ` (${flags})` : ""}\n  ID: ${b.id} | ${b.shortUrl}`
        })

        return { title: `${boards.length} boards`, output: lines.join("\n\n"), metadata: { count: boards.length } }
      }),
  }),
)

export const TrelloListsTool = Tool.define(
  "trello_lists",
  Effect.succeed({
    description: "Get all lists on a Trello board with card counts.",
    parameters: z.object({
      board_id: z.string().describe("Board ID (use trello_boards to find)"),
    }),
    execute: (params: { board_id: string }, _ctx: Tool.Context) =>
      Effect.promise(async () => {
        const lists = await trelloFetch(`/boards/${params.board_id}/lists?cards=open&card_fields=name`)

        if (!lists?.length) {
          return { title: "No lists", output: "No lists on this board.", metadata: { count: 0 } }
        }

        const lines = lists.map((l: any) => {
          const cardCount = l.cards?.length ?? 0
          return `- **${l.name}** — ${cardCount} cards\n  ID: ${l.id}`
        })

        return { title: `${lists.length} lists`, output: lines.join("\n\n"), metadata: { count: lists.length } }
      }),
  }),
)

export const TrelloCardsTool = Tool.define(
  "trello_cards",
  Effect.succeed({
    description: "List cards on a board or in a specific list.",
    parameters: z.object({
      board_id: z.string().optional().describe("Board ID (list all cards on board)"),
      list_id: z.string().optional().describe("List ID (list cards in specific list)"),
      filter: z.enum(["open", "closed", "all"]).optional().default("open").describe("Card filter (default: open)"),
      max_results: z.number().optional().default(25).describe("Maximum cards to return"),
    }),
    execute: (
      params: { board_id?: string; list_id?: string; filter: "open" | "closed" | "all"; max_results: number },
      _ctx: Tool.Context,
    ) =>
      Effect.promise(async () => {
        if (!params.board_id && !params.list_id) {
          return { title: "Error", output: "Provide either board_id or list_id.", metadata: { count: 0 } }
        }

        const limit = Math.min(params.max_results, 100)
        const endpoint = params.list_id
          ? `/lists/${params.list_id}/cards`
          : `/boards/${params.board_id}/cards`
        const cards = await trelloFetch(`${endpoint}?filter=${params.filter}&limit=${limit}&fields=name,shortUrl,idList,labels,due,dueComplete,idMembers,dateLastActivity&members=true&member_fields=fullName`)

        if (!cards?.length) {
          return { title: "No cards", output: "No cards found.", metadata: { count: 0 } }
        }

        const lines = cards.map((c: any) => {
          const labels = (c.labels ?? []).map((l: any) => l.name || l.color).join(", ")
          const members = (c.members ?? []).map((m: any) => m.fullName).join(", ")
          const due = c.due ? ` | Due: ${c.due.slice(0, 10)}${c.dueComplete ? " (done)" : ""}` : ""
          let line = `- **${c.name}**\n  ID: ${c.id}${due}`
          if (labels) line += ` | Labels: ${labels}`
          if (members) line += ` | Members: ${members}`
          return line
        })

        return { title: `${cards.length} cards`, output: lines.join("\n\n"), metadata: { count: cards.length } }
      }),
  }),
)

export const TrelloReadTool = Tool.define(
  "trello_read",
  Effect.succeed({
    description: "Read full details of a Trello card including description, comments, and checklists.",
    parameters: z.object({
      card_id: z.string().describe("Card ID"),
    }),
    execute: (params: { card_id: string }, _ctx: Tool.Context) =>
      Effect.promise(async () => {
        const card = await trelloFetch(`/cards/${params.card_id}?actions=commentCard&actions_limit=10&checklists=all&members=true&member_fields=fullName`)

        const labels = (card.labels ?? []).map((l: any) => l.name || l.color).join(", ")
        const members = (card.members ?? []).map((m: any) => m.fullName).join(", ")
        const due = card.due ? `Due: ${card.due.slice(0, 10)}${card.dueComplete ? " (done)" : ""}` : ""

        let output = `**${card.name}**\n`
        output += `List: ${card.idList} | ${card.shortUrl}\n`
        if (labels) output += `Labels: ${labels}\n`
        if (members) output += `Members: ${members}\n`
        if (due) output += `${due}\n`
        output += `\n## Description\n${card.desc || "(no description)"}`

        const checklists = card.checklists ?? []
        if (checklists.length > 0) {
          output += "\n\n## Checklists"
          for (const cl of checklists) {
            output += `\n### ${cl.name}`
            for (const item of cl.checkItems ?? []) {
              output += `\n${item.state === "complete" ? "- [x]" : "- [ ]"} ${item.name}`
            }
          }
        }

        const comments = card.actions ?? []
        if (comments.length > 0) {
          output += "\n\n## Recent Comments"
          for (const c of comments) {
            const author = c.memberCreator?.fullName ?? "Unknown"
            const text = c.data?.text ?? ""
            output += `\n- **${author}** (${c.date?.slice(0, 10) ?? ""}): ${text.slice(0, 300)}`
          }
        }

        return { title: card.name, output, metadata: { card_id: card.id } }
      }),
  }),
)

export const TrelloCreateTool = Tool.define(
  "trello_create",
  Effect.succeed({
    description: "Create a new Trello card on a list.",
    parameters: z.object({
      list_id: z.string().describe("List ID to create the card in"),
      name: z.string().describe("Card title"),
      desc: z.string().optional().describe("Card description (markdown)"),
      due: z.string().optional().describe("Due date (ISO 8601, e.g., '2026-05-01')"),
      labels: z.array(z.string()).optional().describe("Label IDs to apply"),
      members: z.array(z.string()).optional().describe("Member IDs to assign"),
      pos: z.enum(["top", "bottom"]).optional().default("bottom").describe("Position in list"),
    }),
    execute: (
      params: {
        list_id: string
        name: string
        desc?: string
        due?: string
        labels?: string[]
        members?: string[]
        pos: "top" | "bottom"
      },
      _ctx: Tool.Context,
    ) =>
      Effect.promise(async () => {
        const body: any = { idList: params.list_id, name: params.name, pos: params.pos }
        if (params.desc) body.desc = params.desc
        if (params.due) body.due = params.due
        if (params.labels?.length) body.idLabels = params.labels.join(",")
        if (params.members?.length) body.idMembers = params.members.join(",")

        const card = await trelloFetch("/cards", {
          method: "POST",
          body: JSON.stringify(body),
        })

        return {
          title: `Created: ${card.name}`,
          output: `Card created: **${card.name}**\nID: ${card.id} | ${card.shortUrl}`,
          metadata: { card_id: card.id },
        }
      }),
  }),
)

export const TrelloUpdateTool = Tool.define(
  "trello_update",
  Effect.succeed({
    description: "Update a Trello card (rename, move, set due date, close, etc.).",
    parameters: z.object({
      card_id: z.string().describe("Card ID"),
      name: z.string().optional().describe("New card title"),
      desc: z.string().optional().describe("New description"),
      list_id: z.string().optional().describe("Move to this list ID"),
      due: z.string().optional().describe("New due date (ISO 8601, or empty to clear)"),
      due_complete: z.boolean().optional().describe("Mark due date as complete"),
      closed: z.boolean().optional().describe("Archive (true) or unarchive (false) the card"),
      pos: z.enum(["top", "bottom"]).optional().describe("New position in list"),
    }),
    execute: (
      params: {
        card_id: string
        name?: string
        desc?: string
        list_id?: string
        due?: string
        due_complete?: boolean
        closed?: boolean
        pos?: "top" | "bottom"
      },
      _ctx: Tool.Context,
    ) =>
      Effect.promise(async () => {
        const body: any = {}
        if (params.name !== undefined) body.name = params.name
        if (params.desc !== undefined) body.desc = params.desc
        if (params.list_id) body.idList = params.list_id
        if (params.due !== undefined) body.due = params.due || null
        if (params.due_complete !== undefined) body.dueComplete = params.due_complete
        if (params.closed !== undefined) body.closed = params.closed
        if (params.pos) body.pos = params.pos

        const card = await trelloFetch(`/cards/${params.card_id}`, {
          method: "PUT",
          body: JSON.stringify(body),
        })

        return {
          title: `Updated: ${card.name}`,
          output: `Card updated: **${card.name}** | ${card.shortUrl}`,
          metadata: { card_id: card.id },
        }
      }),
  }),
)

export const TrelloCommentTool = Tool.define(
  "trello_comment",
  Effect.succeed({
    description: "Add a comment to a Trello card.",
    parameters: z.object({
      card_id: z.string().describe("Card ID"),
      text: z.string().describe("Comment text"),
    }),
    execute: (params: { card_id: string; text: string }, _ctx: Tool.Context) =>
      Effect.promise(async () => {
        const action = await trelloFetch(`/cards/${params.card_id}/actions/comments`, {
          method: "POST",
          body: JSON.stringify({ text: params.text }),
        })

        return {
          title: `Comment on card`,
          output: `Comment added to card ${params.card_id}.`,
          metadata: { card_id: params.card_id, action_id: action.id },
        }
      }),
  }),
)
