import {
  getMe,
  getUpdates,
  sendMessage,
  sendMessageWithKeyboard,
  sendMessageWithButtonRows,
  answerCallbackQuery,
  editMessageReplyMarkup,
  editMessageText,
} from "./api"
import { HarnessCommands } from "../harness/commands"
import { TelegramStore } from "./store"
import { TelegramCorrelation } from "./correlation"
import { PersonaPolicy } from "../persona/policy"
import { Queue } from "../queue/queue"
import { JobWorker } from "../queue/worker"
import { Log } from "../util/log"
import { QuestionID } from "../question/schema"
import type { PersonaConfig } from "../persona/index"
import type { Question } from "../question"

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
  // SDD-03 QR-2/QR-5: carry the request's questions so option labels and
  // follow-up questions come from this in-memory entry, not a global registry.
  questions: Question.Info[]
}

const QUESTION_PREFIX = "q:"
const CUSTOM_PREFIX = "qcustom:"
// SDD-02: inline-keyboard callback for a `/model` selection.
const MODEL_PREFIX = "model:"
// SDD-02 Amendment A: short callback tokens. Telegram caps callback_data at 64
// bytes and a `providerID/modelID` key can exceed that, so the picker never
// embeds the key — it references a candidate by index (`model:pick:<n>`) and a
// page by number (`model:page:<n>`), resolved against per-chat picker state (A3).
const MODEL_PICK_TOKEN = "pick:"
const MODEL_PAGE_TOKEN = "page:"
// SDD-02 Amendment A (A1/A2): K buttons per picker page (was the flat-keyboard cap).
const MODEL_KEYBOARD_CAP = 8
// SDD-02 Amendment A (A6): cap on the per-chat recent-models list.
const RECENT_CAP = 5

// SDD-02 Amendment A (A3): per-chat picker state so short tokens resolve to a
// concrete model key and Prev/Next can be rendered. In-memory and reconstructable
// (a stale token after a restart is handled by re-running `/model`, A4).
interface PickerState {
  term: string
  page: number
  candidates: string[]
}

// A test seam mirroring `Provider.list` + `Provider.defaultModel`: returns all
// model keys already in `Provider.sort` order plus the concrete default key. The
// headless test env strips provider API keys (Provider.list is empty there), so
// picker tests inject a catalog here; production resolves the real one.
type ModelCatalog = { keys: string[]; default: string }
type ModelCatalogSource = () => Promise<ModelCatalog>

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
  let _pendingQuestions = new Map<string, PendingQuestion>()
  // SDD-03 QR-1: the inbound half of the question bridge is a single Bus
  // subscription, not a poller. This holds its unsubscribe handle.
  let _questionUnsub: (() => void) | null = null
  let _deliveryTimer: ReturnType<typeof setInterval> | null = null
  let _lastProgressEdit = new Map<string, number>()
  // SDD-02 Amendment A: per-chat picker state (A3) and recent-models list (A6).
  let _pickerStates = new Map<string, PickerState>()
  let _recentModels = new Map<string, string[]>()
  // Test seam: inject the provider catalog (see ModelCatalogSource above).
  let _modelCatalogOverride: ModelCatalogSource | null = null

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

    // Start long-polling + delivery in background, and wire the question bridge.
    pollLoop()
    startDeliveryLoop()
    await startQuestionBridge()
  }

  export async function stop(): Promise<void> {
    _running = false
    _pollAbort?.abort()
    _pollAbort = null
    _botInfo = null
    if (_questionUnsub) {
      _questionUnsub()
      _questionUnsub = null
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

  // SDD-02 req 13 + Amendment A (A1/A2), SEC-3: `/model`.
  //  - no arg  -> the current effective model + a picker keyboard of this chat's
  //    recent allowed models (most-recent first) then Provider.sort order,
  //    de-duplicated and capped to K (A1).
  //  - <arg> that exactly matches an existing allowed key -> SET it (req 13).
  //  - <arg> otherwise -> case-insensitive substring search over allowed keys,
  //    rendered as a paginated picker (A2).
  // The persona policy is the filter/gate here (defense in depth over the SEC-1
  // executor guard). Any inability to load the policy fails closed (unchanged).
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

    let catalog: ModelCatalog
    try {
      catalog = await getModelCatalog()
    } catch (err) {
      log.warn("telegram: /model could not list providers", { chatId, error: String(err) })
      await sendMessage(_config.bot_token!, chatId, "Could not list models. Please try again.")
      return
    }

    if (arg) {
      // Exact-key precedence (req 13): an existing key SETS it, allowed or an
      // explicit rejection — it is never reinterpreted as a search term.
      if (catalog.keys.includes(arg)) {
        if (!PersonaPolicy.isModelAllowed(policy, arg)) {
          await sendMessage(_config.bot_token!, chatId, `Model ${arg} is not allowed for persona "${persona}".`)
          return
        }
        TelegramStore.setModel(chatId, arg)
        recordRecent(chatId, arg)
        await sendMessage(_config.bot_token!, chatId, `Model set to ${arg} for this chat.`)
        return
      }

      // Search path (A2): case-insensitive substring over allowed keys.
      const matches = searchModels(catalog.keys, arg, policy)
      if (matches.length === 0) {
        await sendMessage(_config.bot_token!, chatId, `No models found matching "${arg}".`)
        return
      }
      _pickerStates.set(chatId, { term: arg, page: 0, candidates: matches })
      await sendPickerPage(chatId, 0, `Models matching "${arg}":`)
      return
    }

    // No-arg picker (A1): recent-then-sorted, policy-filtered, capped to K.
    const suggested = suggestModels(catalog.keys, getRecent(chatId), policy)
    _pickerStates.set(chatId, { term: "", page: 0, candidates: suggested })
    const effective = override ? modelKey(override) : config.model ?? catalog.default
    const header =
      `Current model: ${effective}\n\n` +
      "Pick one below, narrow with /model <search>, or set exactly with /model <providerID>/<modelID>."
    if (suggested.length > 0) {
      await sendPickerPage(chatId, 0, header)
    } else {
      await sendMessage(_config.bot_token!, chatId, `${header}\n\n(no selectable models available for this persona)`)
    }
  }

  // A1: recent allowed keys (most-recent first) then Provider.sort order,
  // de-duplicated, capped to K. All sections are policy-filtered (A5).
  function suggestModels(
    sortedKeys: string[],
    recent: string[],
    policy: PersonaPolicy.ModelPolicy | undefined,
  ): string[] {
    const allowed = (k: string) => PersonaPolicy.isModelAllowed(policy, k)
    const ordered = [...recent.filter(allowed), ...sortedKeys.filter(allowed)]
    const seen = new Set<string>()
    const deduped: string[] = []
    for (const k of ordered) {
      if (seen.has(k)) continue
      seen.add(k)
      deduped.push(k)
    }
    return deduped.slice(0, MODEL_KEYBOARD_CAP)
  }

  // A2/A5: case-insensitive substring search over allowed keys (not capped here;
  // sendPickerPage paginates K per page).
  function searchModels(
    sortedKeys: string[],
    term: string,
    policy: PersonaPolicy.ModelPolicy | undefined,
  ): string[] {
    const needle = term.toLowerCase()
    return sortedKeys.filter((k) => PersonaPolicy.isModelAllowed(policy, k) && k.toLowerCase().includes(needle))
  }

  // A3: render one page of the chat's picker state. Candidate buttons carry a
  // short `model:pick:<globalIndex>` token (NEVER the full key), one per row;
  // Prev/Next controls (`model:page:<n>`) share a trailing row when there is more
  // than one page. Updates the stored page so a later Prev/Next is correct.
  async function sendPickerPage(chatId: string, page: number, text: string): Promise<void> {
    const state = _pickerStates.get(chatId)
    if (!state) return
    const total = state.candidates.length
    const clamped = Math.max(0, Math.min(page, Math.max(0, Math.ceil(total / MODEL_KEYBOARD_CAP) - 1)))
    const start = clamped * MODEL_KEYBOARD_CAP
    const pageKeys = state.candidates.slice(start, start + MODEL_KEYBOARD_CAP)
    state.page = clamped

    const rows: Array<Array<{ text: string; callback_data: string }>> = pageKeys.map((key, i) => [
      { text: key, callback_data: `${MODEL_PREFIX}${MODEL_PICK_TOKEN}${start + i}` },
    ])
    const controls: Array<{ text: string; callback_data: string }> = []
    if (clamped > 0) controls.push({ text: "◀ Prev", callback_data: `${MODEL_PREFIX}${MODEL_PAGE_TOKEN}${clamped - 1}` })
    if (start + MODEL_KEYBOARD_CAP < total)
      controls.push({ text: "Next ▶", callback_data: `${MODEL_PREFIX}${MODEL_PAGE_TOKEN}${clamped + 1}` })
    if (controls.length > 0) rows.push(controls)

    await sendMessageWithButtonRows(_config.bot_token!, chatId, text, rows)
  }

  // Resolve the provider catalog: keys already in Provider.sort order plus the
  // concrete default key. Uses the test seam when set (headless env has no
  // configured providers), otherwise reads the real Provider service.
  async function getModelCatalog(): Promise<ModelCatalog> {
    if (_modelCatalogOverride) return _modelCatalogOverride()
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
            pidByModel.set(model, pid)
            models.push(model)
          }
        }
        const sorted = Provider.sort(models)
        const keys = sorted.map((m: any) => `${pidByModel.get(m)}/${m.id}`)
        return { keys, default: `${def.providerID}/${def.modelID}` }
      },
    })
  }

  // A6: record a successfully-set key in the chat's recent list, most-recent
  // first, de-duplicated, capped. Backs the A1 recent section. In-memory.
  function recordRecent(chatId: string, key: string): void {
    const prior = _recentModels.get(chatId) ?? []
    const next = [key, ...prior.filter((k) => k !== key)].slice(0, RECENT_CAP)
    _recentModels.set(chatId, next)
  }

  function getRecent(chatId: string): string[] {
    return _recentModels.get(chatId) ?? []
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
          const { default: def } = await getModelCatalog()
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
    recordRecent(chatId, key)
    await sendMessage(_config.bot_token!, chatId, `Model set to ${key} for this chat.`)
  }

  // SDD-02 Amendment A (A4/A5): a `model:pick:<n>` selection. Resolve the short
  // token against this chat's picker state to a concrete key, re-check the
  // persona policy (defense in depth), persist on success, record recent (A6).
  // A stale/expired token (no state, or index out of range) changes nothing and
  // asks the user to re-run `/model`; a forbidden resolved model is rejected.
  // Never throws.
  async function handleModelPick(chatId: string, index: number): Promise<void> {
    const state = _pickerStates.get(chatId)
    if (!state || !Number.isInteger(index) || index < 0 || index >= state.candidates.length) {
      await sendMessage(_config.bot_token!, chatId, "That selection has expired. Please re-run /model.")
      return
    }
    const key = state.candidates[index]!
    await handleModelCallback(chatId, key)
  }

  // SDD-02 Amendment A (A3/A4): a `model:page:<n>` control. Re-render the
  // requested page from the chat's picker state. A stale token (no state) asks
  // the user to re-run `/model`. Never throws.
  async function handleModelPage(chatId: string, page: number): Promise<void> {
    const state = _pickerStates.get(chatId)
    if (!state || !Number.isInteger(page)) {
      await sendMessage(_config.bot_token!, chatId, "That selection has expired. Please re-run /model.")
      return
    }
    const text = state.term ? `Models matching "${state.term}":` : "Select a model:"
    await sendPickerPage(chatId, page, text)
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

  // SDD-03 QR-1/QR-13/SC-5: the inbound half of the question bridge. Exactly one
  // Bus.subscribe(Question.Event.Asked) registered inside the directory-scoped
  // Instance context, so it attaches to the same instance-keyed Bus PubSub the
  // `question` tool publishes on (process.cwd()). No timer, no Layer B poll.
  async function startQuestionBridge(): Promise<void> {
    const { Bus } = await import("../bus")
    const { Question } = await import("../question")
    const { Instance } = await import("../project/instance")
    const { InstanceBootstrap } = await import("../project/bootstrap")
    const { AppRuntime } = await import("../effect/app-runtime")

    _questionUnsub = await Instance.provide({
      directory: process.cwd(),
      init: () => AppRuntime.runPromise(InstanceBootstrap),
      fn: () =>
        Bus.subscribe(Question.Event.Asked, (evt) => {
          handleAsked(evt.properties).catch((err) =>
            log.warn("telegram: question bridge handler error", { error: String(err) }),
          )
        }),
    })
    log.info("telegram: question bridge subscribed")
  }

  // SDD-03 QR-2/QR-4/QR-5: resolve the originating chat for the question's
  // session via durable, parent-walk correlation (QR-3). If no chat-owning
  // ancestor exists (scheduler/mesh origin), log and return — the question stays
  // parked on its Layer A Deferred and resolves via its own timeout, no throw
  // (QR-4). Otherwise seed the in-memory progression entry and deliver only the
  // first question; later questions follow one at a time (QR-5).
  async function handleAsked(req: Question.Request): Promise<void> {
    const qid = String(req.id)
    if (_pendingQuestions.has(qid)) return

    const chatId = TelegramCorrelation.resolveChatForSession(String(req.sessionID))
    if (!chatId) {
      log.info("telegram: question has no chat-owning session; not relaying", {
        questionId: qid,
        sessionId: req.sessionID,
      })
      return
    }

    const totalQ = req.questions.length
    log.info("telegram: relaying question to chat", { questionId: qid, chatId, totalQuestions: totalQ })
    _pendingQuestions.set(qid, {
      chatId,
      totalQuestions: totalQ,
      answers: new Array(totalQ).fill(undefined),
      telegramMessageIds: [],
      questions: req.questions,
    })

    // Send only the first question — subsequent ones are sent after each answer.
    await sendQuestionKeyboard(qid, req.questions[0], 0, chatId)
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

      // QR-8: an unknown/expired requestID (e.g. lost to restart) has no entry.
      // The callback was already acknowledged above; just return, no throw.
      const pending = _pendingQuestions.get(requestId)
      if (!pending) return

      const option = pending.questions[qi]?.options[oi]
      if (!option) return

      await submitQuestionAnswer(requestId, qi, option.label, chatId)
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
      // SDD-02 req 14 + Amendment A (A3/A4): a `/model` inline callback. Amendment
      // A tokens (`pick:<n>`/`page:<n>`) resolve against per-chat picker state so
      // callback_data stays within Telegram's 64-byte cap; a bare `provider/model`
      // is the legacy exact-key selection. All set paths re-check the policy
      // before persisting (SEC-3, defense in depth).
      const rest = data.slice(MODEL_PREFIX.length)
      if (rest.startsWith(MODEL_PICK_TOKEN)) {
        await handleModelPick(chatId, parseInt(rest.slice(MODEL_PICK_TOKEN.length), 10))
      } else if (rest.startsWith(MODEL_PAGE_TOKEN)) {
        await handleModelPage(chatId, parseInt(rest.slice(MODEL_PAGE_TOKEN.length), 10))
      } else if (rest) {
        await handleModelCallback(chatId, rest)
      }
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

    // Check if all questions are answered — send the next one from the entry
    // (QR-5), never a global registry.
    const nextUnanswered = pending.answers.findIndex((a) => a === undefined)
    if (nextUnanswered >= 0) {
      const nextQuestion = pending.questions[nextUnanswered]
      if (nextQuestion) {
        await sendQuestionKeyboard(requestId, nextQuestion, nextUnanswered, chatId)
      }
      return
    }

    // All answered — succeed the parked Layer A Deferred through the
    // instance-scoped reply path (QR-7/QR-13/SC-5). Question.Service state is
    // keyed by directory, so this MUST run inside Instance.provide({ directory:
    // process.cwd() }): a bare AppRuntime.runPromise(Question.Service.use(...))
    // carries no instance ALS context, throws LocalContext.NotFound, and never
    // resolves the Deferred. A reply for an already-gone request logs a warning
    // and returns void inside the service (QR-8) — it does NOT throw here.
    try {
      const answers = pending.answers.map((a) => [a!])
      const { Question } = await import("../question")
      const { Instance } = await import("../project/instance")
      const { InstanceBootstrap } = await import("../project/bootstrap")
      const { AppRuntime } = await import("../effect/app-runtime")
      await Instance.provide({
        directory: process.cwd(),
        init: () => AppRuntime.runPromise(InstanceBootstrap),
        fn: () =>
          AppRuntime.runPromise(
            Question.Service.use((svc) => svc.reply({ requestID: QuestionID.make(requestId), answers })),
          ),
      })
      _pendingQuestions.delete(requestId)
      log.info("telegram: all questions answered", { requestId, answers: pending.answers })
    } catch (err) {
      log.error("telegram: failed to submit answers", { error: String(err) })
      await sendMessage(_config.bot_token!, chatId, "Failed to submit answers.")
    }
  }

  // ---- SDD-02 Amendment A test seams ------------------------------------
  // The headless test env strips provider API keys, so `Provider.list` is empty
  // and the real picker would offer nothing. These seams let acceptance tests
  // inject a catalog and seed the in-memory recent/picker state. Production never
  // calls them (they only mutate in-memory state that `_reset` clears).

  /** Inject the provider catalog used by the picker (null restores the real one). */
  export function __setModelCatalog(source: ModelCatalogSource | null): void {
    _modelCatalogOverride = source
  }

  /** Seed a chat's recent-models list (most-recent first). */
  export function __seedRecent(chatId: string, keys: string[]): void {
    _recentModels.set(chatId, keys.slice(0, RECENT_CAP))
  }

  /** Seed a chat's picker state so a `model:pick:<n>` token resolves. */
  export function __seedPicker(chatId: string, state: PickerState): void {
    _pickerStates.set(chatId, state)
  }

  export function _reset(): void {
    _running = false
    _pollAbort?.abort()
    _pollAbort = null
    _config = { ...DEFAULT_CONFIG }
    _botInfo = null
    _offset = undefined
    _chatStates = new Map()
    _pendingQuestions = new Map()
    _lastProgressEdit = new Map()
    _pickerStates = new Map()
    _recentModels = new Map()
    _modelCatalogOverride = null
    if (_questionUnsub) {
      _questionUnsub()
      _questionUnsub = null
    }
    if (_deliveryTimer) {
      clearInterval(_deliveryTimer)
      _deliveryTimer = null
    }
    JobWorker.setDeliveryHook(null)
  }
}
