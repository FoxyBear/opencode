import { Hono } from "hono"
import { Mesh, type MeshMessage } from "./mesh"
import { Log } from "../util/log"
import { lazy } from "../util/lazy"

const log = Log.create({ service: "mesh.routes" })

export const MeshRoutes = lazy(() =>
  new Hono()
    .get("/peers", async (c) => {
      const peers = await Mesh.peers()
      return c.json(peers)
    })
    .get("/status", async (c) => {
      return c.json({
        name: Mesh.getNodeName(),
        status: Mesh.getStatus(),
        standalone: Mesh.isStandalone(),
      })
    })
    .post("/message", async (c) => {
      try {
        const body = await c.req.json<MeshMessage>()
        const verified = await Mesh.receiveMessage(body)
        if (!verified) {
          log.warn("mesh message rejected: bad HMAC", { from: body.from })
          return c.json({ error: "HMAC verification failed" }, 401)
        }
        return c.json({ ok: true })
      } catch (err) {
        log.error("mesh message route error", { error: String(err) })
        return c.json({ error: "Invalid message" }, 400)
      }
    })
    .post("/delegate", async (c) => {
      try {
        const body = await c.req.json<{ to: string; prompt: string; persona?: string }>()
        const sessionId = await Mesh.delegate({
          to: body.to,
          prompt: body.prompt,
          persona: body.persona,
        })
        return c.json({ ok: true, session_id: sessionId })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.error("mesh delegate route error", { error: message })
        return c.json({ error: message }, 400)
      }
    }),
)
