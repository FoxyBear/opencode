import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Scheduler } from "../../scheduler/scheduler"
import { errors } from "../error"
import { lazy } from "../../util/lazy"

export const SchedulerRoutes = lazy(() =>
  new Hono()
    .get(
      "/tasks",
      describeRoute({
        summary: "List scheduled tasks",
        description: "Get all scheduled tasks with status and next fire time.",
        operationId: "scheduler.tasks.list",
        responses: {
          200: {
            description: "List of scheduled tasks",
            content: { "application/json": { schema: resolver(z.array(z.any())) } },
          },
        },
      }),
      async (c) => {
        const tasks = await Scheduler.listTasks()
        return c.json(tasks)
      },
    )
    .post(
      "/tasks",
      describeRoute({
        summary: "Add a scheduled task",
        description: "Create a new scheduled task with cron expression and prompt.",
        operationId: "scheduler.tasks.add",
        responses: {
          200: {
            description: "Created task",
            content: { "application/json": { schema: resolver(z.any()) } },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          name: z.string(),
          cron: z.string(),
          prompt: z.string(),
          persona: z.string().optional(),
        }),
      ),
      async (c) => {
        const input = c.req.valid("json")
        const task = await Scheduler.addTask(input)
        return c.json(task)
      },
    )
    .delete(
      "/tasks/:id",
      describeRoute({
        summary: "Remove a scheduled task",
        description: "Delete a scheduled task by ID.",
        operationId: "scheduler.tasks.remove",
        responses: {
          200: {
            description: "Task removed",
            content: { "application/json": { schema: resolver(z.boolean()) } },
          },
          ...errors(404),
        },
      }),
      async (c) => {
        const id = c.req.param("id")
        await Scheduler.removeTask(id)
        return c.json(true)
      },
    )
    .post(
      "/tasks/:id/enable",
      describeRoute({
        summary: "Enable or disable a scheduled task",
        description: "Toggle the enabled state of a scheduled task.",
        operationId: "scheduler.tasks.enable",
        responses: {
          200: {
            description: "Task updated",
            content: { "application/json": { schema: resolver(z.boolean()) } },
          },
          ...errors(404),
        },
      }),
      validator(
        "json",
        z.object({
          enabled: z.boolean(),
        }),
      ),
      async (c) => {
        const id = c.req.param("id")
        const { enabled } = c.req.valid("json")
        await Scheduler.enableTask(id, enabled)
        return c.json(true)
      },
    )
    .post(
      "/tasks/:id/run",
      describeRoute({
        summary: "Run a scheduled task immediately",
        description: "Fire a scheduled task right now, bypassing its cron schedule.",
        operationId: "scheduler.tasks.run",
        responses: {
          200: {
            description: "Session ID from task execution",
            content: { "application/json": { schema: resolver(z.object({ sessionId: z.string() })) } },
          },
          ...errors(404),
        },
      }),
      async (c) => {
        const id = c.req.param("id")
        const sessionId = await Scheduler.runNow(id)
        return c.json({ sessionId })
      },
    )
    .get(
      "/log",
      describeRoute({
        summary: "Get scheduler execution log",
        description: "Get recent scheduler execution history, optionally filtered by task ID.",
        operationId: "scheduler.log",
        responses: {
          200: {
            description: "Log entries",
            content: { "application/json": { schema: resolver(z.array(z.any())) } },
          },
        },
      }),
      validator(
        "query",
        z.object({
          taskId: z.string().optional(),
          limit: z.coerce.number().optional(),
        }),
      ),
      async (c) => {
        const { taskId, limit } = c.req.valid("query")
        const entries = await Scheduler.getLog(taskId, limit ?? 50)
        return c.json(entries)
      },
    ),
)
