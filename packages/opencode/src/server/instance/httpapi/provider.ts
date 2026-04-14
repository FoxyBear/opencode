import { AppLayer } from "@/effect/app-runtime"
import { memoMap } from "@/effect/run-service"
import { ProviderAuth } from "@/provider/auth"
import { lazy } from "@/util/lazy"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import type { Handler } from "hono"

const root = "/experimental/httpapi/provider"

const Api = HttpApi.make("provider")
  .add(
    HttpApiGroup.make("provider")
      .add(
        HttpApiEndpoint.get("auth", `${root}/auth`, {
          success: ProviderAuth.Methods,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.auth",
            summary: "Get provider auth methods",
            description: "Retrieve available authentication methods for all AI providers.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "provider",
          description: "Experimental HttpApi provider routes.",
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

const auth = Effect.fn("ProviderHttpApi.auth")(function* () {
  const svc = yield* ProviderAuth.Service
  return Schema.decodeUnknownSync(ProviderAuth.Methods)(yield* svc.methods())
})

const ProviderLive = HttpApiBuilder.group(Api, "provider", (handlers) => handlers.handle("auth", auth))

const web = lazy(() =>
  HttpRouter.toWebHandler(
    Layer.mergeAll(
      AppLayer,
      HttpApiBuilder.layer(Api, { openapiPath: `${root}/doc` }).pipe(
        Layer.provide(ProviderLive),
        Layer.provide(HttpServer.layerServices),
      ),
    ),
    {
      disableLogger: true,
      memoMap,
    },
  ),
)

export const ProviderHttpApiHandler: Handler = (c, _next) => web().handler(c.req.raw)
