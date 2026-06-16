import type { Hono } from "hono"
import { MeshRoutes } from "../mesh/routes"
import { SchedulerRoutes } from "../server/routes/scheduler"

export function harnessInstanceRoutes(app: Hono) {
  app.route("/mesh", MeshRoutes())
  app.route("/scheduler", SchedulerRoutes())
}
