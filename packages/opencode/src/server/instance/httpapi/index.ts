import { lazy } from "@/util/lazy"
import { Hono } from "hono"
import { ConfigHttpApiHandler } from "./config"
import { QuestionHttpApiHandler } from "./question"

export const HttpApiRoutes = lazy(() =>
  new Hono()
    .all("/question", QuestionHttpApiHandler)
    .all("/question/*", QuestionHttpApiHandler)
    .all("/config", ConfigHttpApiHandler)
    .all("/config/*", ConfigHttpApiHandler),
)
