import {
  getMe,
  getUpdates,
  sendMessage,
  sendMessageWithKeyboard,
  answerCallbackQuery,
  editMessageReplyMarkup,
  editMessageText,
} from "./api"
import { HarnessCommands } from "../harness/commands"
import { TelegramStore } from "./store"
import { PersonaPolicy } from "../persona/policy"
import { Queue } from "../queue/queue"
import { JobWorker } from "../queue/worker"
import { Log } from "../util/log"
import type { PersonaConfig } from "../persona/index"

const log = Log.create({ service: "telegram" })

export interface TelegramConfig {
  enabled: boolean
  bot_token?: string
  allowed_chat_ids: string[]
  notify_chat_id?: string
  persona: string
  session_timeout_ms: number
  progress_interval_ms: number
  max_response_length: number
}

const DEFAULT_CONFIG: TelegramConfig = {
  enabled: false,
  allowed_chat_ids: [],
  persona: "katya",
  session_timeout_ms: 10 * 60 * 1000, // 10 minutes
  progress_interval_ms: 60 * 1000, // 1 minute
  max_response_length: 4096,
}

// Lean per-chat in-heap state. The durable session/correlation lives in
// `telegram_session` / `job_queue` (CC-1); the only thing kept here is the
// transient "awaiting a typed custom answer" flag for the question relay
// (retained pending SDD-03's rewrite).
interface ChatState {
  awaitingCustomAnswer?: {
    questionRequestId: string
    questionIndex: number
  }
}

interface PendingQuestion {
  chatId: string
  totalQuestions: number
  answers: (string | undefined)[]
  telegramMessageIds: number[]
}

const QUESTION_PREFIX = "q:"
const CUSTOM_PREFIX = "qcustom:"
// SDD-02: inline-keyboard callback for a `/model` selection.
const MODEL_PREFIX = "model:"
// SDD-02: cap the `/model` keyboard — sendMessageWithKeyboard renders one button
// per row, so an unbounded list would flood the chat.
const MODEL_KEYBOARD_CAP = 8

const DELIVERY_INTERVAL_MS = 1500
const PROGRESS_DEBOUNCE_MS = 3000

// SDD-01 req 11: `/new` and `/resume` are chat-scoped and handled locally in the
// bot layer, never routed through HarnessCommands. They are appended to `/help`
// output so the registry help still lists every command a user can issue.
const LOCAL_COMMAND_HELP =
  "\n\nSession:\n" +
  "  /new — start a fresh conversation (unbinds this chat's session)\n" +
  "  /resume <session-id> — bind this chat to an existing session\n" +
  "  /model [provider/model] — show or set this chat's model\n" +
  "  /status — show this chat's session, model, and persona"

export namespace TelegramBot {
  let _running = false
  let _config: TelegramConfig = { ...DEFAULT_CONFIG }
  let _botInfo: { id: number; username?: string } | null = null
  let _offset: number | undefined
  let _chatStates = new Map<string, ChatState>()
  let _pollAbort: AbortController | null = null
  let _sessionToChat = new Map<string, string>()
  let _pendingQuestions = new Map<string, PendingQuestion>()
  let _questionPollTimer: ReturnType<typeof setInterval> | null = null
  let _deliveryTimer: ReturnType<typeof setInterval> | null = null
  let _lastProgressEdit = new Map<string, number>()

  export async function start(config?: Partial<TelegramConfig>): Promise<void> {
    _config = { ...DEFAULT_CONFIG, ...config }

    if (!_config.enabled || !_config.bot_token) {
      log.info("telegram: disabled or no token configured")
      return
    }

    // TG-04: Verify token via getMe
    try {
      const me = await getMe(_config.bot_token)
      _botInfo = { id: me.id, username: me.username }
      log.info("telegram: bot verified", { username: me.username, id: me.id })
    } catch (err) {
      log.error("telegram: invalid bot token, disabling", { error: String(err) })
      _running = false
      return
    }

    _running = true
    _pollAbort = new AbortController()

    // W-5: seed the poll offset durably from the inbox, not from lost memory.
    _offset = Queue.derivePollOffset()

    // The delivery loop is the durable backbone (W-20); the worker's nudge is a
    // latency optimization layered on top.
    JobWorker.setDeliveryHook(() => {
      deliveryPass().catch((err) => log.warn("telegram: delivery pass error", { error: String(err) }))
    })

    // Start long-polling + delivery + question relay in background
    pollLoop()
    startDeliveryLoop()
    startQuestionPoller()
  }

  export async function stop(): Promise<void> {
    _running = false
    _pollAbort?.abort()
    _pollAbort = null
    _botInfo = null
    if (_questionPollTimer) {
      clearInterval(_questionPollTimer)
      _questionPollTimer = null
    }
    if (_deliveryTimer) {
      clearInterval(_deliveryTimer)
      _deliveryTimer = null
    }
    JobWorker.setDeliveryHook(null)
    log.info("telegram: bot stopped")
  }

  export function isRunning(): boolean {
    return _running
  }

  export function getBotInfo(): { id: number; username?: string } | null {
    return _botInfo
  }

  export function getConfig(): TelegramConfig {
    return { ..._config }
  }

  export function configure(config: Partial<TelegramConfig>): void {
    _config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Send a notification to the configured notify_chat_id.
   * Used by scheduler for task output routing.
   */
  export async function notify(text: string): Promise<void> {
    if (!_config.bot_token || !_config.notify_chat_id) {
      log.warn("telegram: notify called but no token or notify_chat_id configured")
      return
    }
    await sendMessage(_config.bot_token, _config.notify_chat_id, text)
  }

  async function pollLoop(): Promise<void> {
    while (_running) {
      try {
        const updates = await getUpdates(_config.bot_token!, _offset, 30)
        for (const update of updates) {
          // In-heap offset cache only; the durable inbox is the boot authority.
          _offset = update.update_id + 1
          if (update.callback_query) {
            // Non-chat update: dedup without enqueuing (W-4).
            if (!Queue.inboxCheckAndInsert(update.update_id)) continue
            await handleCallbackQuery(update.callback_query)
          } else if (update.message?.text) {
            await handleMessage(update.message, update.update_id)
          }
        }
      } catch (err) {
        if (_running) {
          log.error("telegram: poll error", { error: String(err) })
          await new Promise((r) => setTimeout(r, 5000))
        }
      }
    }
  }

  async function handleMessage(message: any, updateId: number): Promise<void> {
    const chatId = String(message.chat.id)
    const text = message.text?.trim()
    if (!text) return

    // TG-06: Check allowed chat IDs
    if (_config.allowed_chat_ids.length > 0 && !_config.allowed_chat_ids.includes(chatId)) {
      return // Ignore silently
    }

    // TG-14, TG-15: Handle harness commands via shared registry, before enqueue
    // (W-24). Slash commands are handled inline and never become jobs.
    const cmd = text.split(/[\s@]/)[0]
    if (cmd.startsWith("/")) {
      const slashName = cmd.slice(1)
      const args = text.slice(cmd.length).trim()

      // SDD-01 req 11: `/new` and `/resume` are chat-scoped session-mutating
      // commands. They read/write this chat's telegram_session row and validate
      // sessions via the SDK, so they are dispatched here in the bot layer
      // (where chatId, TelegramStore, and the SDK are in scope) and returned
      // early — they MUST NOT reach the shared HarnessCommands registry.
      if (slashName === "new" || slashName === "resume") {
        // Dedup the inline command before mutating so a redelivered update
        // cannot apply it twice.
        if (!Queue.inboxCheckAndInsert(updateId)) return
        if (slashName === "new") {
          await handleNew(chatId)
        } else {
          await handleResume(chatId, args)
        }
        return
      }

      // SDD-02 req 11-13, 19: `/model` and `/status` are chat-scoped (they need
      // chatId, the chat's persona/policy, TelegramStore, and the provider list),
      // so they are handled here in the bot layer and never routed through the
      // shared HarnessCommands registry. `/status` intentionally shadows the
      // registry `/status` on the Telegram surface with a per-chat view.
      if (slashName === "model" || slashName === "status") {
        if (!Queue.inboxCheckAndInsert(updateId)) return
        if (slashName === "model") {
          await handleModel(chatId, args)
        } else {
          await handleStatus(chatId)
        }
        return
      }

      const known = slashName === "help" || !!HarnessCommands.find(slashName)
      if (known) {
        // Dedup the inline command before executing so a redelivered update
        // cannot run it twice (e.g. /stop).
        if (!Queue.inboxCheckAndInsert(updateId)) return
        if (slashName === "help") {
          await sendMessage(_config.bot_token!, chatId, HarnessCommands.helpText() + LOCAL_COMMAND_HELP)
          return
        }
        const result = await HarnessCommands.execute(slashName, args, { chatId })
        if (result) await sendMessage(_config.bot_token!, chatId, result.text)
        return
      }
      // Unknown slash command falls through to normal prompt handling.
    }

    // Handle custom text answer for a pending question (relay path, SDD-03 rewires)
    const state = getChatState(chatId)
    if (state.awaitingCustomAnswer) {
      if (!Queue.inboxCheckAndInsert(updateId)) return
      const { questionRequestId, questionIndex } = state.awaitingCustomAnswer
      state.awaitingCustomAnswer = undefined
      log.info("telegram: received custom answer", { chatId, questionRequestId, answer: text.slice(0, 50) })
      await submitQuestionAnswer(questionRequestId, questionIndex, text, chatId)
      return
    }

    await processMessage(chatId, text, message.message_id, updateId)
  }

  // Ack-first ingestion (CC-4). The inbox check-and-insert AND the job insert
  // commit atomically (SC-3); the ack is sent only AFTER that commit, then its
  // id is stored (W-7). No inline HeadlessSession.run (W-8).
  async function processMessage(chatId: string, text: string, messageId: number, updateId: number): Promise<void> {
    const row = TelegramStore.getByChat(chatId)
    const sessionId = row?.session_id ?? undefined
    const model = TelegramStore.parseModel(row?.model_override)
    const persona = row?.persona ?? _config.persona

    const { enqueued, jobId } = Queue.ingestChatMessage(updateId, {
      kind: "chat_message",
      payload: {
        prompt: text,
        persona,
        timeoutMs: _config.session_timeout_ms,
        ...(sessionId ? { sessionId } : {}),
        ...(model ? { model } : {}),
      },
      chat_id: chatId,
      reply_to_message_id: messageId,
    })

    if (!enqueued || !jobId) return // duplicate update (W-4)

    // AFTER commit: post the ack and record its id (W-7). If this throws, the
    // job survives with ack_message_id NULL and the delivery loop uses a fresh
    // sendMessage (W-7a / W-17a).
    try {
      const sent = await sendMessage(_config.bot_token!, chatId, "⏳ Working on it...")
      if (sent?.message_id) Queue.setAck(jobId, sent.message_id)
    } catch (err) {
      log.warn("telegram: ack send failed", { chatId, error: String(err) })
    }

    JobWorker.nudge()
  }

  // SDD-01 req 6: `/new` unbinds the chat's durable session (session_id -> NULL)
  // while preserving model_override and persona, so the next message starts a
  // fresh session (worker create + write-back). It does NOT delete the
  // underlying FoxyBear session rows; it only unbinds this chat.
  async function handleNew(chatId: string): Promise<void> {
    TelegramStore.clearSession(chatId)
    await sendMessage(
      _config.bot_token!,
      chatId,
      "Started a fresh session. Your next message begins a new conversation.",
    )
  }

  // SDD-01 req 7: `/resume <id>` binds the chat to an existing FoxyBear session
  // after validating it exists via the SDK. A missing arg replies with usage; an
  // unknown id replies not-found; both leave the current mapping untouched.
  async function handleResume(chatId: string, args: string): Promise<void> {
    const sessionId = args.split(/\s+/)[0]?.trim()
    if (!sessionId) {
      await sendMessage(_config.bot_token!, chatId, "Usage: /resume <session-id>")
      return
    }
    if (!(await sessionExists(sessionId))) {
      await sendMessage(_config.bot_token!, chatId, `No session found for id ${sessionId}.`)
      return
    }
    TelegramStore.setSession(chatId, sessionId)
    await sendMessage(
      _config.bot_token!,
      chatId,
      `Resumed session ${sessionId}. Your next message continues that conversation.`,
    )
  }

  function personaForChat(chatId: string): string {
    return TelegramStore.getByChat(chatId)?.persona ?? _config.persona
  }

  // SDD-02: load the chat persona's config inside instance context so its model
  // policy can be evaluated. Throws when the persona file is missing or fails to
  // parse (fail-closed, SC-4): callers treat a throw as "cannot determine the
  // policy" and refuse to offer or set a model rather than defaulting to
  // allow-all.
  async function loadPersonaConfig(persona: string): Promise<PersonaConfig> {
    const { Persona } = await import("../persona/index")
    const { Instance } = await import("../project/instance")
    const { InstanceBootstrap } = await import("../project/bootstrap")
    const { AppRuntime } = await import("../effect/app-runtime")
    return Instance.provide({
      directory: process.cwd(),
      init: () => AppRuntime.runPromise(InstanceBootstrap),
      fn: () => Persona.load(persona),
    })
  }

  function modelKey(model: { providerID: string; modelID: string }): string {
    return `${model.providerID}/${model.modelID}`
  }

  // SDD-02 req 11-13, SEC-3: `/model` shows the current effective model + an
  // inline keyboard of ALLOWED models (no arg), or sets a per-chat override
  // (with arg). The persona policy is the filter/gate here (defense in depth
  // over the SEC-1 executor guard). Any inability to load the policy fails
  // closed: the model is left unchanged.
  async function handleModel(chatId: string, args: string): Promise<void> {
    const arg = args.trim()
    const persona = personaForChat(chatId)
    const override = TelegramStore.getModel(chatId)

    let config: PersonaConfig
    try {
      config = await loadPersonaConfig(persona)
    } catch (err) {
      log.warn("telegram: /model could not load persona policy", { persona, error: String(err) })
      await sendMessage(_config.bot_token!, chatId, `Could not load persona "${persona}"; model unchanged.`)
      return
    }
    const policy = config.models

    if (arg) {
      // Set path (req 13): parse -> exists? -> allowed? -> persist override.
      try {
        const { exists, key } = await checkModel(arg)
        if (!exists) {
          await sendMessage(_config.bot_token!, chatId, `Unknown model: ${arg}. It is not available on any configured provider.`)
          return
        }
        if (!PersonaPolicy.isModelAllowed(policy, key)) {
          await sendMessage(_config.bot_token!, chatId, `Model ${key} is not allowed for persona "${persona}".`)
          return
        }
        TelegramStore.setModel(chatId, key)
        await sendMessage(_config.bot_token!, chatId, `Model set to ${key} for this chat.`)
      } catch (err) {
        log.warn("telegram: /model set failed", { chatId, arg, error: String(err) })
        await sendMessage(_config.bot_token!, chatId, "Could not set the model. Please try again.")
      }
      return
    }

    // List path (req 11-12): current effective model + allowed keyboard.
    try {
      const { candidates, def } = await listAllowedModels(policy)
      const effective = override ? modelKey(override) : config.model ?? def
      const buttons = candidates.map((key) => ({ text: key, callback_data: `${MODEL_PREFIX}${key}` }))
      const text = `Current model: ${effective}`
      if (buttons.length > 0) {
        await sendMessageWithKeyboard(_config.bot_token!, chatId, `${text}\n\nSelect a model:`, buttons)
      } else {
        await sendMessage(_config.bot_token!, chatId, `${text}\n\n(no selectable models available for this persona)`)
      }
    } catch (err) {
      log.warn("telegram: /model list failed", { chatId, error: String(err) })
      await sendMessage(_config.bot_token!, chatId, "Could not list models. Please try again.")
    }
  }

  // Validate a `provider/model` string exists on some configured provider,
  // reusing Provider.parseModel + Provider.getModel (req 13). Returns the parsed
  // key so the caller can reuse it.
  async function checkModel(arg: string): Promise<{ exists: boolean; key: string }> {
    const { Provider } = await import("../provider/provider")
    const { Instance } = await import("../project/instance")
    const { InstanceBootstrap } = await import("../project/bootstrap")
    const { AppRuntime } = await import("../effect/app-runtime")
    const { Effect } = await import("effect")
    return Instance.provide({
      directory: process.cwd(),
      init: () => AppRuntime.runPromise(InstanceBootstrap),
      async fn() {
        const parsed = Provider.parseModel(arg)
        const key = `${parsed.providerID}/${parsed.modelID}`
        const exists = await AppRuntime.runPromise(
          Effect.gen(function* () {
            const svc = yield* Provider.Service
            yield* svc.getModel(parsed.providerID, parsed.modelID)
            return true
          }),
        ).catch(() => false)
        return { exists, key }
      },
    })
  }

  // Enumerate provider models, filter through the persona policy (req 12),
  // order via Provider.sort, and cap to MODEL_KEYBOARD_CAP. Also returns the
  // concrete default model key for the current-model display.
  async function listAllowedModels(
    policy: PersonaPolicy.ModelPolicy | undefined,
  ): Promise<{ candidates: string[]; def: string }> {
    const { Provider } = await import("../provider/provider")
    const { Instance } = await import("../project/instance")
    const { InstanceBootstrap } = await import("../project/bootstrap")
    const { AppRuntime } = await import("../effect/app-runtime")
    const { Effect } = await import("effect")
    return Instance.provide({
      directory: process.cwd(),
      init: () => AppRuntime.runPromise(InstanceBootstrap),
      async fn() {
        const { providers, def } = await AppRuntime.runPromise(
          Effect.gen(function* () {
            const svc = yield* Provider.Service
            return { providers: yield* svc.list(), def: yield* svc.defaultModel() }
          }),
        )
        const pidByModel = new Map<any, string>()
        const models: any[] = []
        for (const [pid, prov] of Object.entries(providers)) {
          for (const model of Object.values((prov as any).models)) {
            const key = `${pid}/${(model as any).id}`
            if (PersonaPolicy.isModelAllowed(policy, key)) {
              pidByModel.set(model, pid)
              models.push(model)
            }
          }
        }
        const sorted = Provider.sort(models).slice(0, MODEL_KEYBOARD_CAP)
        const candidates = sorted.map((m: any) => `${pidByModel.get(m)}/${m.id}`)
        return { candidates, def: `${def.providerID}/${def.modelID}` }
      },
    })
  }

  // SDD-02 req 19: per-chat session, effective model, and persona.
  async function handleStatus(chatId: string): Promise<void> {
    const row = TelegramStore.getByChat(chatId)
    const persona = personaForChat(chatId)
    const override = TelegramStore.getModel(chatId)
    const sessionId = row?.session_id ?? "(none — next message starts a new session)"

    let model: string
    if (override) {
      model = modelKey(override)
    } else {
      try {
        const config = await loadPersonaConfig(persona)
        if (config.model) {
          model = config.model
        } else {
          const { def } = await listAllowedModels(config.models)
          model = def
        }
      } catch (err) {
        log.warn("telegram: /status model resolution failed", { persona, error: String(err) })
        model = "(unresolved)"
      }
    }

    await sendMessage(
      _config.bot_token!,
      chatId,
      `Session: ${sessionId}\nModel: ${model}\nPersona: ${persona}`,
    )
  }

  // SDD-02 req 14, SEC-3: a `/model` inline selection. Re-check the policy (never
  // trust the button alone), persist on success, error otherwise. On any policy
  // load failure, fail closed and leave the override unchanged.
  async function handleModelCallback(chatId: string, key: string): Promise<void> {
    const persona = personaForChat(chatId)
    let config: PersonaConfig
    try {
      config = await loadPersonaConfig(persona)
    } catch (err) {
      log.warn("telegram: model callback could not load persona policy", { persona, error: String(err) })
      await sendMessage(_config.bot_token!, chatId, `Could not load persona "${persona}"; model unchanged.`)
      return
    }
    if (!PersonaPolicy.isModelAllowed(config.models, key)) {
      await sendMessage(_config.bot_token!, chatId, `Model ${key} is not allowed for persona "${persona}".`)
      return
    }
    TelegramStore.setModel(chatId, key)
    await sendMessage(_config.bot_token!, chatId, `Model set to ${key} for this chat.`)
  }

  // Probe whether a FoxyBear session exists, mirroring the executor's
  // Instance.provide pattern (src/daemon/runner.ts) so the SDK call runs with
  // full instance context. A thrown error, an error result, or a missing data
  // payload all mean the session does not exist (req 7). The v2 client does not
  // throw on non-2xx by default, so the error/data shape must be inspected.
  async function sessionExists(sessionId: string): Promise<boolean> {
    const { Server } = await import("../server/server")
    const { createOpencodeClient } = await import("@opencode-ai/sdk/v2")
    const { Instance } = await import("../project/instance")
    const { InstanceBootstrap } = await import("../project/bootstrap")
    const { AppRuntime } = await import("../effect/app-runtime")

    try {
      return await Instance.provide({
        directory: process.cwd(),
        init: () => AppRuntime.runPromise(InstanceBootstrap),
        async fn(): Promise<boolean> {
          const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const request = new Request(input, init)
            return Server.Default().app.fetch(request)
          }) as typeof globalThis.fetch
          const sdk = createOpencodeClient({ baseUrl: "http://foxybear.internal", fetch: fetchFn })
          const res: any = await sdk.session.messages({ sessionID: sessionId } as any)
          return !res?.error && res?.data != null
        },
      })
    } catch (err) {
      log.info("telegram: /resume session probe failed", { sessionId, error: String(err) })
      return false
    }
  }

  function startDeliveryLoop(): void {
    _deliveryTimer = setInterval(() => {
      deliveryPass().catch((err) => log.warn("telegram: delivery pass error", { error: String(err) }))
    }, DELIVERY_INTERVAL_MS)
  }

  // Table-driven delivery (CC-5). Delivers terminal results by editing the ack
  // message, and reflects progress on non-terminal jobs, debounced (CC-7).
  async function deliveryPass(): Promise<void> {
    if (!_config.bot_token) return

    // Terminal jobs: deliver once and mark delivered (W-17, W-17a, W-18, W-19).
    for (const job of Queue.pendingDelivery()) {
      try {
        const formatted = formatTerminal(job)
        if (job.ack_message_id != null) {
          await editMessageText(_config.bot_token, job.chat_id, job.ack_message_id, formatted)
        } else {
          const sent = await sendMessage(_config.bot_token, job.chat_id, formatted)
          if (sent?.message_id) Queue.setAck(job.id, sent.message_id)
        }
        Queue.markDelivered(job.id)
      } catch (err) {
        log.warn("telegram: delivery failed", { jobId: job.id, error: String(err) })
      }
    }

    // Progress: edit the single ack message, debounced per chat (W-21..W-23).
    for (const job of Queue.runningWithProgress()) {
      const last = _lastProgressEdit.get(job.chat_id) ?? 0
      if (Date.now() - last < PROGRESS_DEBOUNCE_MS) continue
      try {
        await editMessageText(_config.bot_token, job.chat_id, job.ack_message_id!, `⏳ ${job.progress}`)
        _lastProgressEdit.set(job.chat_id, Date.now())
      } catch (err) {
        log.warn("telegram: progress edit failed", { jobId: job.id, error: String(err) })
      }
    }
  }

  function formatTerminal(job: Queue.Job): string {
    if (job.status === "canceled") return "Cancelled. I stopped replying to that request."
    if (job.status === "error") return `Error: ${(job.error ?? "unknown error").slice(0, 200)}`
    const response = job.result?.response ?? ""
    if (!response) return "(empty response)"
    const maxLen = _config.max_response_length
    return response.length > maxLen ? response.slice(0, maxLen) + "\n\n_(truncated)_" : response
  }

  function getChatState(chatId: string): ChatState {
    if (!_chatStates.has(chatId)) {
      _chatStates.set(chatId, {})
    }
    return _chatStates.get(chatId)!
  }

  function startQuestionPoller(): void {
    _questionPollTimer = setInterval(async () => {
      if (!_running) return
      try {
        await pollPendingQuestions()
      } catch (err) {
        log.warn("telegram: question poll error", { error: String(err) })
      }
    }, 2000)
  }

  async function pollPendingQuestions(): Promise<void> {
    const { Question } = await import("../question")
    const questions = Question.globalList()
    if (questions.length === 0) return

    for (const q of questions) {
      const qid = String(q.id)
      if (_pendingQuestions.has(qid)) continue
      // Resolve chat from the in-heap cache, falling back to the durable
      // correlation the worker persisted (TelegramStore). SDD-03 rewires this.
      const chatId = _sessionToChat.get(String(q.sessionID)) ?? TelegramStore.getBySession(String(q.sessionID))?.chat_id
      if (!chatId) continue

      const totalQ = q.questions.length
      log.info("telegram: relaying question to chat", { questionId: qid, chatId, totalQuestions: totalQ })
      _pendingQuestions.set(qid, { chatId, totalQuestions: totalQ, answers: new Array(totalQ).fill(undefined), telegramMessageIds: [] })

      // Send only the first question — subsequent ones are sent after each answer
      await sendQuestionKeyboard(qid, q.questions[0], 0, chatId)
    }
  }

  async function handleCallbackQuery(cbq: any): Promise<void> {
    const data = cbq.data as string | undefined
    const chatId = String(cbq.message?.chat?.id ?? cbq.from?.id ?? "")

    log.info("telegram: callback_query received", { data, chatId, fromId: cbq.from?.id })
    await answerCallbackQuery(_config.bot_token!, cbq.id).catch(() => {})

    if (!data) return

    if (data.startsWith(QUESTION_PREFIX)) {
      const parts = data.slice(QUESTION_PREFIX.length).split(":")
      const [requestId, qiStr, oiStr] = parts
      if (!requestId || !qiStr || !oiStr) return

      const qi = parseInt(qiStr, 10)
      const oi = parseInt(oiStr, 10)

      const pending = _pendingQuestions.get(requestId)
      if (!pending) return

      const { Question } = await import("../question")
      const questions = Question.globalList()
      const q = questions.find((x: any) => x.id === requestId)
      if (!q || !q.questions[qi]?.options[oi]) return

      const label = q.questions[qi].options[oi].label
      await submitQuestionAnswer(requestId, qi, label, chatId)
    } else if (data.startsWith(CUSTOM_PREFIX)) {
      const parts = data.slice(CUSTOM_PREFIX.length).split(":")
      const [requestId, qiStr] = parts
      if (!requestId || !qiStr) {
        log.warn("telegram: malformed custom callback data", { data })
        return
      }

      const state = getChatState(chatId)
      state.awaitingCustomAnswer = { questionRequestId: requestId, questionIndex: parseInt(qiStr, 10) }
      log.info("telegram: awaiting custom answer", { chatId, requestId })
      await sendMessage(_config.bot_token!, chatId, "Type your answer:")
    } else if (data.startsWith(MODEL_PREFIX)) {
      // SDD-02 req 14: a `/model` inline selection. Re-check the policy before
      // persisting (SEC-3, defense in depth).
      const key = data.slice(MODEL_PREFIX.length)
      if (!key) return
      await handleModelCallback(chatId, key)
    } else {
      log.warn("telegram: unknown callback data", { data })
    }
  }

  async function sendQuestionKeyboard(requestId: string, question: any, qi: number, chatId: string): Promise<void> {
    const buttons = question.options.map((opt: any, oi: number) => ({
      text: opt.label,
      callback_data: `${QUESTION_PREFIX}${requestId}:${qi}:${oi}`,
    }))
    buttons.push({
      text: "✏️ Type your answer",
      callback_data: `${CUSTOM_PREFIX}${requestId}:${qi}`,
    })

    const header = question.header ? `${question.header}: ` : ""
    const text = `${header}${question.question}\n\n${question.options.map((o: any) => `• ${o.label} — ${o.description}`).join("\n")}`
    try {
      const sent = await sendMessageWithKeyboard(_config.bot_token!, chatId, text, buttons)
      const pending = _pendingQuestions.get(requestId)
      if (pending && sent?.message_id) {
        pending.telegramMessageIds.push(sent.message_id)
      }
    } catch (err) {
      log.error("telegram: failed to send question keyboard", { error: String(err) })
    }
  }

  async function submitQuestionAnswer(requestId: string, questionIndex: number, answer: string, chatId: string): Promise<void> {
    const pending = _pendingQuestions.get(requestId)
    if (!pending) {
      log.warn("telegram: answer for unknown question", { requestId })
      return
    }

    // Remove the keyboard from the answered question
    const msgId = pending.telegramMessageIds[questionIndex]
    if (msgId) await editMessageReplyMarkup(_config.bot_token!, chatId, msgId)

    await sendMessage(_config.bot_token!, chatId, `✓ ${answer}`)
    pending.answers[questionIndex] = answer

    // Check if all questions are answered
    const nextUnanswered = pending.answers.findIndex((a) => a === undefined)
    if (nextUnanswered >= 0) {
      const { Question } = await import("../question")
      const allQuestions = Question.globalList()
      const q = allQuestions.find((x: any) => x.id === requestId)
      if (q?.questions[nextUnanswered]) {
        await sendQuestionKeyboard(requestId, q.questions[nextUnanswered], nextUnanswered, chatId)
      }
      return
    }

    // All answered — submit via global registry (resolves the Effect deferred directly)
    try {
      const answers = pending.answers.map((a) => [a!])
      const { Question } = await import("../question")
      const ok = Question.globalReply(requestId as any, answers)
      if (!ok) {
        log.warn("telegram: question no longer pending", { requestId })
        await sendMessage(_config.bot_token!, chatId, "Question expired.")
      }
      _pendingQuestions.delete(requestId)
      log.info("telegram: all questions answered", { requestId, answers: pending.answers })
    } catch (err) {
      log.error("telegram: failed to submit answers", { error: String(err) })
      await sendMessage(_config.bot_token!, chatId, "Failed to submit answers.")
    }
  }

  export function _reset(): void {
    _running = false
    _pollAbort?.abort()
    _pollAbort = null
    _config = { ...DEFAULT_CONFIG }
    _botInfo = null
    _offset = undefined
    _chatStates = new Map()
    _sessionToChat = new Map()
    _pendingQuestions = new Map()
    _lastProgressEdit = new Map()
    if (_questionPollTimer) {
      clearInterval(_questionPollTimer)
      _questionPollTimer = null
    }
    if (_deliveryTimer) {
      clearInterval(_deliveryTimer)
      _deliveryTimer = null
    }
    JobWorker.setDeliveryHook(null)
  }
}
