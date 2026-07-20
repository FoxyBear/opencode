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
import { Queue } from "../queue/queue"
import { JobWorker } from "../queue/worker"
import { Log } from "../util/log"

const log = Log.create({ service: "telegram" })

export interface TelegramConfig {
  enabled: boolean
  bot_token?: string
  allowed_chat_ids: string[]
  notify_chat_id?: string
  persona: string
  session_ttl_ms: number
  session_timeout_ms: number
  progress_interval_ms: number
  max_response_length: number
}

const DEFAULT_CONFIG: TelegramConfig = {
  enabled: false,
  allowed_chat_ids: [],
  persona: "katya",
  session_ttl_ms: 30 * 60 * 1000, // 30 minutes
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

const DELIVERY_INTERVAL_MS = 1500
const PROGRESS_DEBOUNCE_MS = 3000

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
      const known = slashName === "help" || !!HarnessCommands.find(slashName)
      if (known) {
        // Dedup the inline command before executing so a redelivered update
        // cannot run it twice (e.g. /stop).
        if (!Queue.inboxCheckAndInsert(updateId)) return
        if (slashName === "help") {
          await sendMessage(_config.bot_token!, chatId, HarnessCommands.helpText())
          return
        }
        const result = await HarnessCommands.execute(slashName, text.slice(cmd.length).trim(), { chatId })
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
