import { lazy } from "@/util/lazy"
import { Hono } from "hono"
import { ProviderHttpApiHandler } from "./provider"
import { QuestionHttpApiHandler } from "./question"

export const HttpApiRoutes = lazy(() =>
  new Hono()
    .all("/question", QuestionHttpApiHandler)
    .all("/question/*", QuestionHttpApiHandler)
    .all("/provider", ProviderHttpApiHandler)
    .all("/provider/*", ProviderHttpApiHandler),
)
