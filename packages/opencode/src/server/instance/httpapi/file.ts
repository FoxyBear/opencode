import { AppLayer } from "@/effect/app-runtime"
import { memoMap } from "@/effect/run-service"
import { File } from "@/file"
import { lazy } from "@/util/lazy"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import type { Handler } from "hono"

const root = "/experimental/httpapi/file"

const Api = HttpApi.make("file")
  .add(
    HttpApiGroup.make("file")
      .add(
        HttpApiEndpoint.get("list", root, {
          query: { path: Schema.optional(Schema.String) },
          success: Schema.Array(File.Node),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "file.list",
            summary: "List files",
            description: "List files and directories in a specified path.",
          }),
        ),
        HttpApiEndpoint.get("content", `${root}/content`, {
          query: { path: Schema.String },
          success: File.Content,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "file.read",
            summary: "Read file",
            description: "Read the content of a specified file.",
          }),
        ),
        HttpApiEndpoint.get("status", `${root}/status`, {
          success: Schema.Array(File.Info),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "file.status",
            summary: "Get file status",
            description: "Get the git status of all files in the project.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "file",
          description: "Experimental HttpApi file routes.",
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

const list = Effect.fn("FileHttpApi.list")(function* (ctx: { query: { path?: string } }) {
  const svc = yield* File.Service
  return Schema.decodeUnknownSync(Schema.Array(File.Node))(yield* svc.list(ctx.query.path))
})

const content = Effect.fn("FileHttpApi.content")(function* (ctx: { query: { path: string } }) {
  const svc = yield* File.Service
  return Schema.decodeUnknownSync(File.Content)(yield* svc.read(ctx.query.path))
})

const status = Effect.fn("FileHttpApi.status")(function* () {
  const svc = yield* File.Service
  return Schema.decodeUnknownSync(Schema.Array(File.Info))(yield* svc.status())
})

const FileLive = HttpApiBuilder.group(Api, "file", (handlers) =>
  handlers.handle("list", list).handle("content", content).handle("status", status),
)

const web = lazy(() =>
  HttpRouter.toWebHandler(
    Layer.mergeAll(
      AppLayer,
      HttpApiBuilder.layer(Api, { openapiPath: `${root}/doc` }).pipe(
        Layer.provide(FileLive),
        Layer.provide(HttpServer.layerServices),
      ),
    ),
    {
      disableLogger: true,
      memoMap,
    },
  ),
)

export const FileHttpApiHandler: Handler = (c, _next) => web().handler(c.req.raw)
