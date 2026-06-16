import z from "zod"
import { Effect } from "effect"
import { Tool } from "../tool/tool"
import { Mesh, type MessageType } from "./mesh"

// ── mesh_send ──

export const MeshSendTool = Tool.define(
  "mesh_send",
  Effect.succeed({
    description:
      "Send a message to a peer node in the mesh network. Use this to communicate directives, queries, or status updates to other FoxyBear instances.",
    parameters: z.object({
      to: z.string().describe("The name of the target peer node"),
      type: z.enum(["directive", "status", "query", "response"]).describe("The message type"),
      payload: z.record(z.string(), z.any()).describe("The message payload"),
    }),
    execute: (
      params: {
        to: string
        type: "directive" | "status" | "query" | "response"
        payload: Record<string, any>
      },
      _ctx: Tool.Context,
    ) =>
      Effect.promise(async () => {
        try {
          await Mesh.send({
            to: params.to,
            type: params.type as MessageType,
            payload: params.payload as Record<string, unknown>,
          })
          return {
            title: "Message sent",
            output: `Sent to ${params.to}`,
            metadata: {},
          }
        } catch (error) {
          return {
            title: "Message send failed",
            output: String(error instanceof Error ? error.message : error),
            metadata: {},
          }
        }
      }),
  }),
)

// ── mesh_peers ──

export const MeshPeersTool = Tool.define(
  "mesh_peers",
  Effect.succeed({
    description:
      "List all discovered peer nodes in the mesh network, including their status, capabilities, and connection info.",
    parameters: z.object({}),
    execute: (_params: {}, _ctx: Tool.Context) =>
      Effect.promise(async () => {
        try {
          const peers = await Mesh.peers()

          if (peers.length === 0) {
            return {
              title: "No peers",
              output: "No mesh peers discovered.",
              metadata: { count: 0 },
            }
          }

          const formatted = peers
            .map(
              (p, i) =>
                `${i + 1}. ${p.name} (${p.status}) — ${p.address}:${p.port}\n   persona: ${p.persona}, capabilities: ${p.capabilities.join(", ") || "none"}`,
            )
            .join("\n")

          return {
            title: `${peers.length} peer(s)`,
            output: formatted,
            metadata: { count: peers.length },
          }
        } catch (error) {
          return {
            title: "Peer list failed",
            output: `Error listing peers: ${String(error)}`,
            metadata: { count: 0 },
          }
        }
      }),
  }),
)

// ── mesh_delegate ──

export const MeshDelegateTool = Tool.define(
  "mesh_delegate",
  Effect.succeed({
    description:
      "Delegate a task to a peer node in the mesh network. The peer creates a session, runs the prompt, and the peer's response is returned synchronously. If the peer is busy, the request is queued on the peer side and this tool waits for completion.",
    parameters: z.object({
      to: z.string().describe("The name of the target peer node"),
      prompt: z.string().describe("The prompt/task to delegate"),
      persona: z.string().optional().describe("The persona to use on the peer (default: 'default')"),
      timeout_ms: z
        .number()
        .optional()
        .describe("Max time to wait for the peer's response (ms). Default 300000."),
    }),
    execute: (
      params: { to: string; prompt: string; persona?: string; timeout_ms?: number },
      _ctx: Tool.Context,
    ) =>
      Effect.promise(async () => {
        try {
          // Spec 16 §C-01 / §C-03 / §C-04 — synchronous peer query. Progress
          // messages are consolidated into the final output so the caller
          // can see if it was queued.
          const progress: string[] = []
          const result = await Mesh.query({
            to: params.to,
            prompt: params.prompt,
            persona: params.persona,
            timeoutMs: params.timeout_ms,
            onProgress: (e) => {
              if (e.status === "queued") {
                progress.push(`queued on ${params.to} at position ${e.queuedPosition}`)
              }
            },
          })
          if (result.status === "error") {
            return {
              title: "Peer returned error",
              output: result.error ?? "unknown peer error",
              metadata: { session_id: "" },
            }
          }
          const output = [...progress, result.response ?? ""].filter(Boolean).join("\n\n")
          return {
            title: `Peer ${params.to} responded`,
            output,
            metadata: { session_id: result.sessionId ?? "" },
          }
        } catch (error) {
          return {
            title: "Peer query failed",
            output: String(error instanceof Error ? error.message : error),
            metadata: { session_id: "" },
          }
        }
      }),
  }),
)
