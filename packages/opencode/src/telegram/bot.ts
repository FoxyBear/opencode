import { getMe, getUpdates, sendMessage, sendMessageWithKeyboard, answerCallbackQuery, editMessageReplyMarkup } from "./api"
import { HeadlessSession } from "../daemon/headless"
import { HarnessCommands } from "../harness/commands"
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

interface ChatState {
  lastSessionTime: number
  lastSessionSummary?: string
  processing: boolean
  queue: Array<{ text: string; chatId: string; messageId: number }>
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

    // Start long-polling in background
    pollLoop()
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
          _offset = update.update_id + 1
          if (update.callback_query) {
            await handleCallbackQuery(update.callback_query)
          } else if (update.message?.text) {
            await handleMessage(update.message)
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

  async function handleMessage(message: any): Promise<void> {
    const chatId = String(message.chat.id)
    const text = message.text?.trim()
    if (!text) return

    // TG-06: Check allowed chat IDs
    if (_config.allowed_chat_ids.length > 0 && !_config.allowed_chat_ids.includes(chatId)) {
      return // Ignore silently
    }

    // TG-14, TG-15: Handle harness commands via shared registry
    const cmd = text.split(/[\s@]/)[0]
    if (cmd.startsWith("/")) {
      const slashName = cmd.slice(1)
      if (slashName === "help") {
        await sendMessage(_config.bot_token!, chatId, HarnessCommands.helpText())
        return
      }
      const result = await HarnessCommands.execute(slashName, text.slice(cmd.length).trim())
      if (result) {
        await sendMessage(_config.bot_token!, chatId, result.text)
        return
      }
    }

    // Handle custom text answer for a pending question
    const state = getChatState(chatId)
    log.info("telegram: handleMessage", { chatId, awaiting: !!state.awaitingCustomAnswer, processing: state.processing, textPreview: text.slice(0, 30) })
    if (state.awaitingCustomAnswer) {
      const { questionRequestId, questionIndex } = state.awaitingCustomAnswer
      state.awaitingCustomAnswer = undefined
      log.info("telegram: received custom answer", { chatId, questionRequestId, answer: text.slice(0, 50) })
      await submitQuestionAnswer(questionRequestId, questionIndex, text, chatId)
      return
    }

    // TG-09: Queue if chat already processing
    if (state.processing) {
      state.queue.push({ text, chatId, messageId: message.message_id })
      log.info("telegram: message queued", { chatId, queueLength: state.queue.length })
      return
    }

    await processMessage(chatId, text)
  }

  async function processMessage(chatId: string, text: string): Promise<void> {
    const state = getChatState(chatId)
    state.processing = true

    try {
      // TG-10, TG-11: Check session TTL for conversation continuity
      const now = Date.now()
      const withinTtl = state.lastSessionTime > 0 && (now - state.lastSessionTime) < _config.session_ttl_ms
      let prompt = text
      if (withinTtl && state.lastSessionSummary) {
        prompt = `[Previous session context: ${state.lastSessionSummary}]\n\n${text}`
      }

      const progressTimer = startProgressFeedback(chatId)

      let trackedSessionId: string | undefined
      let result: Awaited<ReturnType<typeof HeadlessSession.run>>
      try {
        result = await HeadlessSession.run({
          prompt,
          persona: _config.persona,
          timeoutMs: _config.session_timeout_ms,
          onSessionCreated(sessionId) {
            trackedSessionId = sessionId
            _sessionToChat.set(sessionId, chatId)
            log.info("telegram: session mapped to chat", { sessionId, chatId })
          },
        })
      } finally {
        clearInterval(progressTimer)
        if (trackedSessionId) _sessionToChat.delete(trackedSessionId)
      }

      state.lastSessionTime = now
      state.lastSessionSummary = result.response.slice(0, 500)

      const maxLen = _config.max_response_length
      const response = result.response.length > maxLen
        ? result.response.slice(0, maxLen) + "\n\n_(truncated)_"
        : result.response
      await sendMessage(_config.bot_token!, chatId, response)
    } catch (err) {
      // TG-08: Send error summary
      const errMsg = String(err)
      await sendMessage(_config.bot_token!, chatId, `Error: ${errMsg.slice(0, 200)}`)
      log.error("telegram: session failed", { chatId, error: errMsg })
    } finally {
      state.processing = false

      // Process queued messages
      if (state.queue.length > 0) {
        const next = state.queue.shift()!
        await processMessage(next.chatId, next.text)
      }
    }
  }

  const PROGRESS_MESSAGES = [
    "Still working on this...",
    "Taking a bit longer than expected, but still on it.",
    "Still here, still working.",
    "Haven't forgotten about you — still processing.",
    "This one's taking some time. Still on it.",
  ]

  function startProgressFeedback(chatId: string): ReturnType<typeof setInterval> {
    let tick = 0
    return setInterval(async () => {
      const msg = PROGRESS_MESSAGES[tick % PROGRESS_MESSAGES.length]
      try {
        await sendMessage(_config.bot_token!, chatId, `⏳ ${msg}`)
      } catch (err) {
        log.warn("telegram: failed to send progress message", { chatId, error: String(err) })
      }
      tick++
    }, _config.progress_interval_ms)
  }

  function getChatState(chatId: string): ChatState {
    if (!_chatStates.has(chatId)) {
      _chatStates.set(chatId, { lastSessionTime: 0, processing: false, queue: [] })
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
      const chatId = _sessionToChat.get(String(q.sessionID))
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
    if (_questionPollTimer) {
      clearInterval(_questionPollTimer)
      _questionPollTimer = null
    }
  }
}
