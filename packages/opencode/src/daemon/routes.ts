import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { DaemonLifecycle } from "./lifecycle"
import { HeadlessSession } from "./headless"
import { Installation } from "../installation"
import { Scheduler } from "../scheduler/scheduler"
import { Mesh } from "../mesh/mesh"
import { getGlobalMemoryBackend } from "../memory/backend-registry"

const HealthResponseSchema = z.object({
  status: z.literal("running"),
  version: z.string(),
  uptime_seconds: z.number(),
  subsystems: z.object({
    database: z.boolean(),
    graph: z.boolean(),
    mesh: z.boolean(),
    scheduler: z.boolean(),
    telegram: z.boolean(),
    http: z.boolean(),
  }),
  active_sessions: z.number(),
  queued_tasks: z.number(),
  mesh_peers: z.number(),
  last_scheduler_tick: z.string().nullable(),
})

const SessionRequestSchema = z.object({
  prompt: z.string(),
  persona: z.string().optional(),
  timeout_ms: z.number().optional().default(300_000),
})

const SessionResponseSchema = z.object({
  session_id: z.string(),
  response: z.string(),
  tool_calls: z.number(),
  duration_ms: z.number(),
  status: z.enum(["success", "error", "timeout"]),
})

const StatusResponseSchema = z.object({
  status: z.literal("running"),
  version: z.string(),
  uptime_seconds: z.number(),
  subsystems: z.record(z.string(), z.boolean()),
  queued_tasks: z.number(),
  peers: z.array(z.object({ name: z.string(), status: z.string() })),
  memory: z.object({
    instance_count: z.number(),
    project_count: z.number(),
    global_count: z.number(),
  }),
})

export function memoryRoutes() {
  return new Hono()
    .post("/memory/write", async (c) => {
      const backend = getGlobalMemoryBackend()
      if (!backend) return c.json({ error: "memory backend not available" }, 503)
      const body = await c.req.json()
      const input = { ...body, embedding: new Float32Array(body.embedding) }
      const result = await backend.write(input)
      return c.json(result)
    })
    .post("/memory/query", async (c) => {
      const backend = getGlobalMemoryBackend()
      if (!backend) return c.json({ error: "memory backend not available" }, 503)
      const body = await c.req.json()
      const input = { ...body, queryEmbedding: new Float32Array(body.queryEmbedding) }
      const results = await backend.query(input)
      return c.json(results)
    })
    .post("/memory/forget", async (c) => {
      const backend = getGlobalMemoryBackend()
      if (!backend) return c.json({ error: "memory backend not available" }, 503)
      const { id } = await c.req.json()
      await backend.forget(id)
      return c.json({ ok: true })
    })
    .post("/memory/list", async (c) => {
      const backend = getGlobalMemoryBackend()
      if (!backend) return c.json({ error: "memory backend not available" }, 503)
      const { persona, limit } = await c.req.json()
      const results = await backend.list(persona, limit)
      return c.json(results)
    })
    .get("/memory/metrics", async (c) => {
      const backend = getGlobalMemoryBackend()
      if (!backend) return c.json({ error: "memory backend not available" }, 503)
      const metrics = await backend.metrics()
      return c.json(metrics)
    })
    .post("/memory/prunable", async (c) => {
      const backend = getGlobalMemoryBackend()
      if (!backend) return c.json({ error: "memory backend not available" }, 503)
      const { ttl_days } = await c.req.json()
      const results = await backend.getPrunable(ttl_days)
      return c.json(results)
    })
}

export function DaemonRoutes() {
  return new Hono()
    .route("", memoryRoutes())
    .get(
      "/health",
      describeRoute({
        summary: "Daemon health",
        description: "Returns daemon status: uptime, active subsystems, running tasks, mesh peers.",
        operationId: "daemon.health",
        responses: {
          200: {
            description: "Daemon health status",
            content: { "application/json": { schema: resolver(HealthResponseSchema) } },
          },
        },
      }),
      async (c) => {
        const subsystems = DaemonLifecycle.getSubsystems()
        const subsystemMap: Record<string, boolean> = {
          database: false,
          graph: false,
          mesh: false,
          scheduler: false,
          telegram: false,
          http: false,
        }
        for (const s of subsystems) {
          (subsystemMap as any)[s.name] = s.healthy
        }

        const peers = await Mesh.peers().catch(() => [])

        return c.json({
          status: "running" as const,
          version: Installation.VERSION,
          uptime_seconds: DaemonLifecycle.getUptime(),
          subsystems: subsystemMap,
          active_sessions: 0,
          queued_tasks: Scheduler.getQueueLength(),
          mesh_peers: peers.length,
          last_scheduler_tick: null,
        })
      },
    )
    .post(
      "/session",
      describeRoute({
        summary: "Create headless session",
        description: "Create a headless session, run to completion, return the response.",
        operationId: "daemon.session.create",
        responses: {
          200: {
            description: "Session response",
            content: { "application/json": { schema: resolver(SessionResponseSchema) } },
          },
        },
      }),
      validator("json", SessionRequestSchema),
      async (c) => {
        if (!HeadlessSession.hasRunner()) {
          return c.json(
            {
              session_id: "",
              response: "Headless session runner not configured",
              tool_calls: 0,
              duration_ms: 0,
              status: "error" as const,
            },
            503,
          )
        }

        const { prompt, persona, timeout_ms } = c.req.valid("json")
        const start = Date.now()

        try {
          const result = await HeadlessSession.run({ prompt, persona, timeoutMs: timeout_ms })
          return c.json({
            session_id: result.sessionId,
            response: result.response,
            tool_calls: result.toolCalls,
            duration_ms: result.durationMs,
            status: "success" as const,
          })
        } catch (err) {
          const isTimeout = String(err).includes("timed out")
          return c.json({
            session_id: "",
            response: String(err),
            tool_calls: 0,
            duration_ms: Date.now() - start,
            status: isTimeout ? ("timeout" as const) : ("error" as const),
          })
        }
      },
    )
    .get(
      "/status",
      describeRoute({
        summary: "Daemon status",
        description: "Returns comprehensive daemon status including sessions, tasks, peers, memory stats.",
        operationId: "daemon.status",
        responses: {
          200: {
            description: "Daemon status",
            content: { "application/json": { schema: resolver(StatusResponseSchema) } },
          },
        },
      }),
      async (c) => {
        const subsystems = DaemonLifecycle.getSubsystems()
        const subsystemMap: Record<string, boolean> = {}
        for (const s of subsystems) {
          subsystemMap[s.name] = s.healthy
        }

        const peers = await Mesh.peers().catch(() => [])

        let instanceCount = 0
        let projectCount = 0
        let globalCount = 0
        try {
          const memBackend = getGlobalMemoryBackend()
          if (memBackend) {
            const m = await memBackend.metrics()
            instanceCount = m.instance_count
            projectCount = m.project_count
            globalCount = m.global_count
          }
        } catch {}

        return c.json({
          status: "running" as const,
          version: Installation.VERSION,
          uptime_seconds: DaemonLifecycle.getUptime(),
          subsystems: subsystemMap,
          queued_tasks: Scheduler.getQueueLength(),
          peers: peers.map((p: any) => ({ name: p.name, status: p.status })),
          memory: {
            instance_count: instanceCount,
            project_count: projectCount,
            global_count: globalCount,
          },
        })
      },
    )
}
