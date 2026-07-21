# 05 — Scheduler

## Objective

Define a harness-integrated cron scheduler that runs within `opencode serve`. Handles internal maintenance tasks (consolidation, pruning, heartbeats) and user-defined scheduled tasks that execute with full harness context.

## Prior Art

- Claude Code KAIROS (unreleased): persistent daemon with 5-minute cron cycles, `autoDream` background consolidation, daily log files
- Claude Code `CronCreate`/`RemoteTrigger`: server-side scheduled agents (runs on Anthropic's servers, not locally)
- OpenCode `server/server.ts`: Hono HTTP server, already long-running in `opencode serve` mode
- OpenCode `session/index.ts:312-358`: `Session.create()` for spawning new sessions programmatically

## Behavior

### Cron Evaluator

**WHEN** `opencode serve` starts and `scheduler.enabled` is true,
the scheduler **SHALL** start a cron evaluator that checks the task table every `check_interval_seconds` (default: 60).

**WHEN** the cron evaluator ticks,
it **SHALL** evaluate all enabled tasks' cron expressions against the current time and fire any that are due.

**WHEN** `opencode serve` shuts down,
the scheduler **SHALL** stop the evaluator and wait for running tasks to complete (grace period: 30s).

**WHEN** `opencode serve` restarts,
the scheduler **SHALL** reload tasks from SQLite and resume firing on schedule (no missed-fire backfill).

### Internal Maintenance Tasks

**WHEN** the scheduler initializes,
it **SHALL** register these internal maintenance tasks (not user-visible, not stored in the task table):

| Task | Schedule | Gate | Operation |
|------|----------|------|-----------|
| Memory consolidation | Evaluator tick | 24h + 5 sessions + PID lock (spec 03) | Trigger `Consolidation.run()` |
| Memory TTL pruning | `pruning_schedule` (default: `0 3 * * *`) | None | Sweep expired memories |
| Mesh peer heartbeat | Every 5 minutes | `mesh.enabled` | Broadcast mDNS status |
| Workforce memory sync | `workforce_sync` (default: `0 */6 * * *`) | `memory.workforce.url` configured | Pull promoted learnings |
| Transcript cleanup | `transcript_cleanup` (default: `0 2 * * 0`) | None | Archive old sessions |

**WHEN** a maintenance task fires,
it **SHALL** run silently with no session transcript unless an error occurs.

**WHEN** a maintenance task fails,
the scheduler **SHALL** log the error to `scheduler_log` and continue (never crash the serve process).

**WHEN** a maintenance task is already running (checked via PID lock),
the scheduler **SHALL** skip this firing and log `"Skipped {task}: already running"`.

### User-Defined Tasks

**WHEN** a user creates a scheduled task via `/schedule add`,
the scheduler **SHALL** persist it in the `scheduled_tasks` table.

**WHEN** a user-defined task fires,
the scheduler **SHALL**:
1. Create a new session via `Session.create()` with the task's persona
2. Inject the task's prompt as the initial user message
3. Run the harness loop with full context (auto-recall, tools, mesh)
4. Capture the assistant's response as a session transcript
5. Route output per the task's `output` config

**WHEN** a user task fires and the persona is not configured,
the scheduler **SHALL** use the default agent and log a warning.

**WHEN** a user task completes successfully,
the scheduler **SHALL** update `last_run` and `last_status = "success"` in the task table and log to `scheduler_log`.

**WHEN** a user task fails,
the scheduler **SHALL** update `last_status = "error"`, log the error to `scheduler_log`, and continue (never disable the task automatically).

### Output Routing

**WHEN** a user task has `output.transcript = true` (always true for user tasks),
the session transcript **SHALL** be preserved and browsable in the TUI.

**WHEN** a user task has `output.mesh_target` set,
the scheduler **SHALL** send the assistant's final response as a mesh message (spec 06) to the target node.

**WHEN** a user task has `output.notification = "telegram"`,
the scheduler **SHALL** send a notification via the Katya MCP tools (if available) — graceful degradation if MCP not configured.

**WHEN** a user task has `output.file_path` set,
the scheduler **SHALL** write the assistant's final response to the specified file path as markdown.

### Concurrency

**WHEN** maintenance tasks run,
at most one instance of each task type **SHALL** be active at a time (PID lock per task type).

**WHEN** user-defined tasks run,
at most `max_concurrent_user_tasks` (default: 3) **SHALL** be active simultaneously.

**WHEN** a user task is due but the concurrency limit is reached,
the scheduler **SHALL** queue it and execute when a slot opens (FIFO order).

**WHEN** an interactive session is active (user chatting),
scheduled tasks **SHALL** still fire — they run in separate sessions and do not interfere.

### Slash Commands

**WHEN** the user types `/schedule add "<cron>" "<prompt>" --persona <name>`,
the scheduler **SHALL** create a new task and persist it.

**WHEN** the user types `/schedule list`,
the scheduler **SHALL** display all tasks with: name, cron expression, next fire time, last run, status, enabled/disabled.

**WHEN** the user types `/schedule remove <id>`,
the scheduler **SHALL** delete the task from the table and log the deletion.

**WHEN** the user types `/schedule enable <id>` or `/schedule disable <id>`,
the scheduler **SHALL** toggle the task's `enabled` flag.

**WHEN** the user types `/schedule run <id>`,
the scheduler **SHALL** fire the task immediately (bypass cron expression), regardless of concurrency limits.

**WHEN** the user types `/schedule log [id]`,
the scheduler **SHALL** display recent execution history from `scheduler_log`, optionally filtered by task ID.

## Interface Contract

```typescript
export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/Scheduler") {}

export interface Interface {
  readonly start: () => Effect.Effect<void>
  readonly stop: () => Effect.Effect<void>
  readonly addTask: (input: TaskInput) => Effect.Effect<ScheduledTask>
  readonly removeTask: (id: string) => Effect.Effect<void>
  readonly enableTask: (id: string, enabled: boolean) => Effect.Effect<void>
  readonly runNow: (id: string) => Effect.Effect<SessionID>
  readonly listTasks: () => Effect.Effect<ScheduledTask[]>
  readonly getLog: (taskId?: string, limit?: number) => Effect.Effect<SchedulerLogEntry[]>
}

export interface ScheduledTask {
  id: string
  name: string
  cron: string
  prompt: string
  persona: string
  category: "maintenance" | "user"
  enabled: boolean
  output: TaskOutput
  last_run?: string
  last_status?: "success" | "error"
  created_at: string
}

export interface TaskOutput {
  transcript: boolean
  mesh_target?: string
  notification?: "telegram" | "system"
  file_path?: string
}

export interface TaskInput {
  name: string
  cron: string
  prompt: string
  persona?: string
  output?: Partial<TaskOutput>
}

export interface SchedulerLogEntry {
  id: string
  task_id: string
  task_name: string
  started_at: string
  completed_at?: string
  status: "running" | "success" | "error"
  error?: string
  session_id?: string
}
```

## Drizzle Schema

```typescript
// scheduler.sql.ts
export const ScheduledTasksTable = sqliteTable("scheduled_tasks", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  cron: text("cron").notNull(),
  prompt: text("prompt").notNull(),
  persona: text("persona").notNull().default("build"),
  category: text("category").notNull().default("user"),
  enabled: integer("enabled", { mode: "boolean" }).default(true),
  output: text("output", { mode: "json" }).$type<TaskOutput>(),
  last_run: integer("last_run", { mode: "timestamp_ms" }),
  last_status: text("last_status"),
  ...Timestamps,
})

export const SchedulerLogTable = sqliteTable("scheduler_log", {
  id: text("id").primaryKey(),
  task_id: text("task_id").notNull(),
  task_name: text("task_name").notNull(),
  started_at: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  completed_at: integer("completed_at", { mode: "timestamp_ms" }),
  status: text("status").notNull().default("running"),
  error: text("error"),
  session_id: text("session_id"),
  ...Timestamps,
})
```

## Harness Operations (automatic)

- Cron evaluator ticks every 60s within `opencode serve`
- Maintenance tasks fire based on schedule + gate conditions
- User tasks create full harness sessions with persona context
- Output routing after task completion

## LLM-Callable Tools

None. The scheduler is infrastructure. Users interact via `/schedule` commands.

## Verification

```bash
bun test src/scheduler/__tests__/scheduler.test.ts

# Task CRUD
# Test: addTask → listTasks → task present → removeTask → task gone

# Cron evaluation
# Test: task with "*/1 * * * *" → evaluator tick → task fires

# User task creates session
# Test: fire user task → Session.create() called with persona → prompt injected → response captured

# Maintenance task with gate
# Test: consolidation task → gate not met → skipped
# Test: consolidation task → gate met → Consolidation.run() called

# Concurrency limit
# Test: 4 user tasks due, limit=3 → 3 run, 1 queued → slot opens → queued task runs

# Persistence across restart
# Test: add task → restart scheduler → listTasks → task present

# Output routing
# Test: task with file_path → response written to file
# Test: task with mesh_target → mesh message sent

# Error handling
# Test: task fails → status="error", logged, task not disabled

# /schedule run (immediate)
# Test: /schedule run <id> → fires immediately, ignores cron
```

## Boundaries

- Scheduler does NOT implement the harness loop (it creates sessions that use the existing loop)
- Scheduler does NOT manage memory directly (scheduled tasks use auto-recall like any session)
- Scheduler does NOT run in TUI mode (only in `opencode serve`)
- Scheduler does NOT backfill missed fires after downtime
