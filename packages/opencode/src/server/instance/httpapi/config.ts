import { AppLayer } from "@/effect/app-runtime"
import { memoMap } from "@/effect/run-service"
import { Provider } from "@/provider/provider"
import { lazy } from "@/util/lazy"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import type { Handler } from "hono"
import { mapValues } from "remeda"

const ApiInfo = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  npm: Schema.String,
}).annotate({ identifier: "ConfigProvidersModelApi" })

const Mode = Schema.Struct({
  text: Schema.Boolean,
  audio: Schema.Boolean,
  image: Schema.Boolean,
  video: Schema.Boolean,
  pdf: Schema.Boolean,
}).annotate({ identifier: "ConfigProvidersModelMode" })

const Interleaved = Schema.Union([
  Schema.Boolean,
  Schema.Struct({
    field: Schema.Union([Schema.Literal("reasoning_content"), Schema.Literal("reasoning_details")]),
  }),
]).annotate({ identifier: "ConfigProvidersModelInterleaved" })

const Capabilities = Schema.Struct({
  temperature: Schema.Boolean,
  reasoning: Schema.Boolean,
  attachment: Schema.Boolean,
  toolcall: Schema.Boolean,
  input: Mode,
  output: Mode,
  interleaved: Interleaved,
}).annotate({ identifier: "ConfigProvidersModelCapabilities" })

const Cache = Schema.Struct({
  read: Schema.Number,
  write: Schema.Number,
}).annotate({ identifier: "ConfigProvidersModelCache" })

const ExperimentalOver200K = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  cache: Cache,
})
  .pipe(Schema.optional)
  .annotate({ identifier: "ConfigProvidersModelExperimentalOver200K" })

const Cost = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  cache: Cache,
  experimentalOver200K: ExperimentalOver200K,
}).annotate({ identifier: "ConfigProvidersModelCost" })

const Limit = Schema.Struct({
  context: Schema.Number,
  input: Schema.optional(Schema.Number),
  output: Schema.Number,
}).annotate({ identifier: "ConfigProvidersModelLimit" })

const Model = Schema.Struct({
  id: Schema.String,
  providerID: Schema.String,
  api: ApiInfo,
  name: Schema.String,
  family: Schema.optional(Schema.String),
  capabilities: Capabilities,
  cost: Cost,
  limit: Limit,
  status: Schema.Union([
    Schema.Literal("alpha"),
    Schema.Literal("beta"),
    Schema.Literal("deprecated"),
    Schema.Literal("active"),
  ]),
  options: Schema.Record(Schema.String, Schema.Unknown),
  headers: Schema.Record(Schema.String, Schema.String),
  release_date: Schema.String,
  variants: Schema.optional(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown))),
}).annotate({ identifier: "ConfigProvidersModel" })

const ProviderInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  source: Schema.Union([
    Schema.Literal("env"),
    Schema.Literal("config"),
    Schema.Literal("custom"),
    Schema.Literal("api"),
  ]),
  env: Schema.Array(Schema.String),
  key: Schema.optional(Schema.String),
  options: Schema.Record(Schema.String, Schema.Unknown),
  models: Schema.Record(Schema.String, Schema.Unknown),
}).annotate({ identifier: "ConfigProvidersProvider" })

const Providers = Schema.Unknown

const root = "/experimental/httpapi/config"

const Api = HttpApi.make("config")
  .add(
    HttpApiGroup.make("config")
      .add(
        HttpApiEndpoint.get("providers", `${root}/providers`, {
          success: Providers,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.providers",
            summary: "List config providers",
            description: "Get a list of all configured AI providers and their default models.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "config",
          description: "Experimental HttpApi config routes.",
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

const providers = Effect.fn("ConfigHttpApi.providers")(function* () {
  const svc = yield* Provider.Service
  const all = mapValues(yield* svc.list(), (item) => item)
  return Schema.decodeUnknownSync(Providers)(
    JSON.parse(
      JSON.stringify({
        providers: Object.values(all),
        default: mapValues(all, (item) => Provider.sort(Object.values(item.models))[0].id),
      }),
    ),
  )
})

const ConfigLive = HttpApiBuilder.group(Api, "config", (handlers) => handlers.handle("providers", providers))

const web = lazy(() =>
  HttpRouter.toWebHandler(
    Layer.mergeAll(
      AppLayer,
      HttpApiBuilder.layer(Api, { openapiPath: `${root}/doc` }).pipe(
        Layer.provide(ConfigLive),
        Layer.provide(HttpServer.layerServices),
      ),
    ),
    {
      disableLogger: true,
      memoMap,
    },
  ),
)

export const ConfigHttpApiHandler: Handler = (c, _next) => web().handler(c.req.raw)
