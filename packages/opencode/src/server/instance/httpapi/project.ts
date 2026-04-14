import { AppLayer } from "@/effect/app-runtime"
import { memoMap } from "@/effect/run-service"
import { Instance } from "@/project/instance"
import { Project } from "@/project/project"
import { lazy } from "@/util/lazy"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import type { Handler } from "hono"

const root = "/experimental/httpapi/project"

const Api = HttpApi.make("project")
  .add(
    HttpApiGroup.make("project")
      .add(
        HttpApiEndpoint.get("list", root, {
          success: Schema.Array(Project.Info),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.list",
            summary: "List all projects",
            description: "Get a list of projects that have been opened with OpenCode.",
          }),
        ),
        HttpApiEndpoint.get("current", `${root}/current`, {
          success: Project.Info,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.current",
            summary: "Get current project",
            description: "Retrieve the currently active project that OpenCode is working with.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "project",
          description: "Experimental HttpApi project routes.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )

const list = Effect.fn("ProjectHttpApi.list")(function* () {
  return Schema.decodeUnknownSync(Schema.Array(Project.Info))(Project.list())
})

const current = Effect.fn("ProjectHttpApi.current")(function* () {
  return Schema.decodeUnknownSync(Project.Info)(Instance.project)
})

const ProjectLive = HttpApiBuilder.group(Api, "project", (handlers) =>
  handlers.handle("list", list).handle("current", current),
)

const web = lazy(() =>
  HttpRouter.toWebHandler(
    Layer.mergeAll(
      AppLayer,
      HttpApiBuilder.layer(Api, { openapiPath: `${root}/doc` }).pipe(
        Layer.provide(ProjectLive),
        Layer.provide(HttpServer.layerServices),
      ),
    ),
    {
      disableLogger: true,
      memoMap,
    },
  ),
)

export const ProjectHttpApiHandler: Handler = (c, _next) => web().handler(c.req.raw)
