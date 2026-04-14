import { lazy } from "@/util/lazy"
import { Hono } from "hono"
import { QuestionHttpApiHandler } from "./question"
import { WorkspaceHttpApiHandler } from "./workspace"

export const HttpApiRoutes = lazy(() =>
  new Hono()
    .all("/question", QuestionHttpApiHandler)
    .all("/question/*", QuestionHttpApiHandler)
    .all("/workspace", WorkspaceHttpApiHandler)
    .all("/workspace/*", WorkspaceHttpApiHandler),
)
