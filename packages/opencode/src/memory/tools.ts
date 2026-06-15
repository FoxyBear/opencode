import z from "zod"
import { Effect } from "effect"
import { Tool } from "../tool/tool"
import { Memory } from "./memory"
import { PersonaSession } from "../persona/session"
import { InstanceState } from "../effect/instance-state"

export function projectIdFromDirectory(directory?: string): string | undefined {
  if (!directory) return undefined
  return directory
}

export const MemoryRememberTool = Tool.define(
  "memory_remember",
  Effect.succeed({
    description:
      "Store a piece of information in persistent memory. Use this to remember important context, decisions, patterns, or user preferences across sessions.",
    parameters: z.object({
      content: z.string().describe("The content to remember"),
    }),
    execute: (params: { content: string }, _ctx: Tool.Context) =>
      Effect.gen(function* () {
        const ins = yield* InstanceState.context
        const projectId = projectIdFromDirectory(ins.directory)
        try {
          const entry = yield* Effect.promise(() =>
            Memory.store({
              content: params.content,
              persona: PersonaSession.getDefault()?.name ?? "default",
              ...(projectId ? { project_id: projectId, scope: "project" } : {}),
            }),
          )
          return {
            title: "Stored memory",
            output: `Stored (project: ${projectId ?? "global"}): ${params.content}`,
            metadata: { id: entry.id },
          }
        } catch (error) {
          return {
            title: "Memory store failed",
            output: `Error storing memory: ${String(error)}`,
            metadata: {},
          }
        }
      }).pipe(Effect.orDie),
  }),
)

export const MemoryRecallTool = Tool.define(
  "memory_recall",
  Effect.succeed({
    description:
      "Search persistent memory for relevant information. Returns the most relevant memories ranked by semantic similarity.",
    parameters: z.object({
      query: z.string().describe("The search query to find relevant memories"),
      limit: z.number().optional().describe("Maximum number of results to return (default: 5)"),
    }),
    execute: (params: { query: string; limit?: number }, _ctx: Tool.Context) =>
      Effect.gen(function* () {
        const ins = yield* InstanceState.context
        const projectId = projectIdFromDirectory(ins.directory)
        try {
          const results = yield* Effect.promise(() =>
            Memory.recall({
              query: params.query,
              persona: PersonaSession.getDefault()?.name ?? "default",
              project_id: projectId,
              limit: params.limit,
              include_workforce: true,
            }),
          )

          if (results.length === 0) {
            return {
              title: "No memories found",
              output: "No relevant memories found.",
              metadata: {},
            }
          }

          const formatted = results
            .map(
              (r, i) =>
                `${i + 1}. [${r.score.toFixed(3)}] ${r.content}${r.source === "workforce" ? " (workforce)" : ""}`,
            )
            .join("\n")

          return {
            title: `${results.length} memories found`,
            output: formatted,
            metadata: { count: results.length },
          }
        } catch (error) {
          return {
            title: "Memory recall failed",
            output: `Error recalling memories: ${String(error)}`,
            metadata: {},
          }
        }
      }).pipe(Effect.orDie),
  }),
)

export const MemoryForgetTool = Tool.define(
  "memory_forget",
  Effect.succeed({
    description:
      "Delete a specific memory by its ID. Use this when information is no longer relevant or correct.",
    parameters: z.object({
      id: z.string().describe("The ID of the memory to forget"),
    }),
    execute: (params: { id: string }, _ctx: Tool.Context) =>
      Effect.promise(async () => {
        try {
          await Memory.forget({ id: params.id })
          return {
            title: "Memory forgotten",
            output: `Forgotten: ${params.id}`,
            metadata: {},
          }
        } catch (error) {
          return {
            title: "Memory forget failed",
            output: `Error forgetting memory: ${String(error)}`,
            metadata: {},
          }
        }
      }),
  }),
)
