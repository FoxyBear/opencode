import { lazy } from "@/util/lazy"
import { Hono } from "hono"
import { FileHttpApiHandler } from "./file"
import { QuestionHttpApiHandler } from "./question"

export const HttpApiRoutes = lazy(() =>
  new Hono()
    .all("/question", QuestionHttpApiHandler)
    .all("/question/*", QuestionHttpApiHandler)
    .all("/file", FileHttpApiHandler)
    .all("/file/*", FileHttpApiHandler),
)
