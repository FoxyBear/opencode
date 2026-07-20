import z from "zod"

export const FoxyBearFields = {
  memory: z
    .object({
      embedding: z
        .object({
          provider: z.enum(["ollama", "deepinfra", "openai"]).default("deepinfra"),
          model: z.string().default("BAAI/bge-base-en-v1.5"),
          dimensions: z.number().int().default(768),
          fallback: z
            .object({
              provider: z.string(),
              model: z.string(),
            })
            .optional(),
        })
        .optional(),
      workforce: z
        .object({
          url: z.string().url().optional(),
          max_results: z.number().int().default(3),
        })
        .optional(),
      dedup_threshold: z.number().min(0).max(1).default(0.95),
      ttl_days: z.number().int().min(0).default(90),
      auto_capture: z
        .boolean()
        .default(true)
        .describe("Enable per-turn memory extraction"),
      consolidation: z
        .object({
          min_hours_between: z.number().min(0).default(24),
          min_sessions_between: z.number().int().min(0).default(5),
          stale_warning_days: z.number().int().min(0).default(1),
          stale_penalty_days: z.number().int().min(0).default(7),
        })
        .optional(),
      graph_backend: z
        .enum(["sqlite", "neo4j", "surreal"])
        .default("sqlite")
        .describe(
          "Graph store backend for project/global memory tiers. " +
            "'sqlite' is the legacy default. " +
            "'surreal' is the recommended backend — embedded SurrealDB via @surrealdb/node, " +
            "vector + graph + text in one DB. " +
            "'neo4j' is the remote-server alternative.",
        ),
      project_tags: z
        .array(z.string())
        .optional()
        .describe("Tags for scoped memory queries (match ANY)"),
      neo4j: z
        .object({
          uri: z.string().describe("Neo4j bolt URI"),
          username: z.string().default("neo4j"),
          password: z.string().describe("Neo4j password (use {env:NEO4J_PASSWORD})"),
        })
        .optional()
        .describe("Neo4j connection config (when graph_backend=neo4j)"),
      surreal: z
        .object({
          url: z.string().default("ws://127.0.0.1:8000"),
          username: z.string().default("root"),
          password: z.string().default("root"),
          namespace: z.string().default("foxybear"),
          database: z.string().default("memory"),
        })
        .optional()
        .describe("SurrealDB connection config (when graph_backend=surreal)"),
    })
    .optional()
    .describe("Persistent memory configuration"),
  persona: z
    .string()
    .optional()
    .describe("Default persona name for all sessions in this project"),
  owner: z
    .object({
      elevated: z
        .boolean()
        .default(false)
        .describe(
          "Whether this is Todd's declared process. Elevated processes preempt " +
            "busy peers, jump the scheduler queue, and (forward-compat) are " +
            "permitted to query all memory scopes. See spec16-finish §F and " +
            "docs/260427_foxybear_spec-elevated-privileges.md.",
        ),
    })
    .optional()
    .default({ elevated: false })
    .describe("Owner-elevation config for Todd's declared process (spec 16 §F)"),
  scheduler: z
    .object({
      enabled: z.boolean().default(false).describe("Enable cron scheduler (serve mode only)"),
      check_interval_seconds: z.number().int().min(1).default(60).describe("Cron evaluator tick interval"),
      max_concurrent_user_tasks: z.number().int().min(1).default(3).describe("Max concurrent user tasks"),
      pruning_schedule: z.string().default("0 3 * * *").describe("Cron for memory TTL pruning"),
      workforce_sync: z.string().default("0 */6 * * *").describe("Cron for workforce memory sync"),
      transcript_cleanup: z.string().default("0 2 * * 0").describe("Cron for old session cleanup"),
    })
    .optional(),
  mesh: z
    .object({
      enabled: z.boolean().default(false).describe("Enable mesh network"),
      name: z.string().default("").describe("Node name (defaults to hostname)"),
      secret: z.string().default("").describe("Shared secret for HMAC signing (use env reference)"),
      mdns: z.boolean().default(true).describe("Enable mDNS discovery"),
    })
    .optional(),
  atlassian: z
    .object({
      api_key: z.string().describe("Trello API key (use {file:path} reference)"),
      api_token: z.string().describe("Trello API token (use {file:path} reference)"),
    })
    .optional(),
  telegram: z
    .object({
      enabled: z.boolean().default(false).describe("Enable Telegram bot transport"),
      bot_token: z.string().optional().describe("Telegram bot token (use {env:TELEGRAM_BOT_TOKEN})"),
      allowed_chat_ids: z.array(z.string()).default([]).describe("Allowed Telegram chat IDs"),
      notify_chat_id: z.string().optional().describe("Chat ID for scheduled task notifications"),
      persona: z.string().default("katya").describe("Default persona for Telegram sessions"),
    })
    .optional(),
}
