import { lazy } from "@/util/lazy"
import { Hono } from "hono"
import { ProjectHttpApiHandler } from "./project"
import { QuestionHttpApiHandler } from "./question"

export const HttpApiRoutes = lazy(() =>
  new Hono()
    .all("/question", QuestionHttpApiHandler)
    .all("/question/*", QuestionHttpApiHandler)
    .all("/project", ProjectHttpApiHandler)
    .all("/project/*", ProjectHttpApiHandler),
)
