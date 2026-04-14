import { listAdaptors } from "@/control-plane/adaptors"
import { Workspace } from "@/control-plane/workspace"
import { WorkspaceID } from "@/control-plane/schema"
import { AppLayer } from "@/effect/app-runtime"
import { memoMap } from "@/effect/run-service"
import { ProjectID } from "@/project/schema"
import { Instance } from "@/project/instance"
import { lazy } from "@/util/lazy"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import type { Handler } from "hono"

class Adaptor extends Schema.Class<Adaptor>("WorkspaceAdaptor")({
  type: Schema.String,
  name: Schema.String,
  description: Schema.String,
}) {}

class Info extends Schema.Class<Info>("Workspace")({
  id: WorkspaceID,
  type: Schema.String,
  name: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  directory: Schema.NullOr(Schema.String),
  extra: Schema.NullOr(Schema.Unknown),
  projectID: ProjectID,
}) {}

class Status extends Schema.Class<Status>("WorkspaceConnectionStatus")({
  workspaceID: WorkspaceID,
  status: Schema.Union([
    Schema.Literal("connected"),
    Schema.Literal("connecting"),
    Schema.Literal("disconnected"),
    Schema.Literal("error"),
  ]),
  error: Schema.optional(Schema.String),
}) {}

const root = "/experimental/httpapi/workspace"

const Api = HttpApi.make("workspace")
  .add(
    HttpApiGroup.make("workspace")
      .add(
        HttpApiEndpoint.get("adaptors", `${root}/adaptor`, {
          success: Schema.Array(Adaptor),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.workspace.adaptor.list",
            summary: "List workspace adaptors",
            description: "List all available workspace adaptors for the current project.",
          }),
        ),
        HttpApiEndpoint.get("list", root, {
          success: Schema.Array(Info),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.workspace.list",
            summary: "List workspaces",
            description: "List all workspaces.",
          }),
        ),
        HttpApiEndpoint.get("status", `${root}/status`, {
          success: Schema.Array(Status),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.workspace.status",
            summary: "Workspace status",
            description: "Get connection status for workspaces in the current project.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "workspace",
          description: "Experimental HttpApi workspace routes.",
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

const adaptors = Effect.fn("WorkspaceHttpApi.adaptors")(function* () {
  return Schema.decodeUnknownSync(Schema.Array(Adaptor))(yield* Effect.promise(() => listAdaptors(Instance.project.id)))
})

const list = Effect.fn("WorkspaceHttpApi.list")(function* () {
  return Schema.decodeUnknownSync(Schema.Array(Info))(Workspace.list(Instance.project))
})

const status = Effect.fn("WorkspaceHttpApi.status")(function* () {
  const ids = new Set(Workspace.list(Instance.project).map((item) => item.id))
  return Schema.decodeUnknownSync(Schema.Array(Status))(Workspace.status().filter((item) => ids.has(item.workspaceID)))
})

const WorkspaceLive = HttpApiBuilder.group(Api, "workspace", (handlers) =>
  handlers.handle("adaptors", adaptors).handle("list", list).handle("status", status),
)

const web = lazy(() =>
  HttpRouter.toWebHandler(
    Layer.mergeAll(
      AppLayer,
      HttpApiBuilder.layer(Api, { openapiPath: `${root}/doc` }).pipe(
        Layer.provide(WorkspaceLive),
        Layer.provide(HttpServer.layerServices),
      ),
    ),
    {
      disableLogger: true,
      memoMap,
    },
  ),
)

export const WorkspaceHttpApiHandler: Handler = (c, _next) => web().handler(c.req.raw)
