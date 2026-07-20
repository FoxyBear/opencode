const BASE = "https://api.telegram.org/bot"

// Transport indirection: every Telegram HTTP call funnels through `_transport`.
// Production uses `realTransport` (the network). Tests inject a recording/mock
// transport via `__setTransport` so the full api.ts logic (message chunking,
// keyboard row building, the editMessageText "not modified" swallow, etc.) still
// runs while the network boundary is stubbed. `__setTransport(null)` restores
// the real transport, so production behavior is identical when no test is
// active. This is the SOLE test seam added to this module.
export type TelegramTransport = (
  token: string,
  method: string,
  body?: Record<string, unknown>,
) => Promise<any>

const realTransport: TelegramTransport = async (token, method, body) => {
  const url = `${BASE}${token}/${method}`
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })

  const data = (await res.json()) as { ok: boolean; result?: any; description?: string }
  if (!data.ok) {
    throw new Error(`Telegram API error: ${data.description ?? res.status}`)
  }
  return data.result
}

let _transport: TelegramTransport = realTransport

/** Test-only: swap the network transport. Pass null to restore production. */
export function __setTransport(transport: TelegramTransport | null): void {
  _transport = transport ?? realTransport
}

export async function telegramApi(token: string, method: string, body?: Record<string, unknown>): Promise<any> {
  return _transport(token, method, body)
}

export async function getMe(token: string): Promise<{ id: number; first_name: string; username?: string }> {
  return telegramApi(token, "getMe")
}

// Telegram rejects a message when its text has an unbalanced Markdown entity
// (a lone `_`, `*`, backtick, or `[`) with "can't parse entities". Session ids
// ("ses_...") and arbitrary LLM output routinely trip this. When it happens we
// MUST NOT drop the reply: retry the same text as plain (no parse_mode) so
// delivery always succeeds, keeping Markdown formatting only when it is valid.
function isParseEntitiesError(err: unknown): boolean {
  return String(err).includes("can't parse entities")
}

// Send one message, preferring Markdown but falling back to plain text if
// Telegram rejects the Markdown parse.
async function sendOne(token: string, chatId: string, text: string): Promise<any> {
  try {
    return await telegramApi(token, "sendMessage", { chat_id: chatId, text, parse_mode: "Markdown" })
  } catch (err) {
    if (isParseEntitiesError(err)) {
      return telegramApi(token, "sendMessage", { chat_id: chatId, text })
    }
    throw err
  }
}

export async function sendMessage(token: string, chatId: string, text: string): Promise<any> {
  // Telegram has a 4096-char limit per message
  const MAX_LEN = 4096
  if (text.length <= MAX_LEN) {
    return sendOne(token, chatId, text)
  }

  // Split into chunks
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, MAX_LEN))
    remaining = remaining.slice(MAX_LEN)
  }

  let lastResult: any
  for (const chunk of chunks) {
    lastResult = await sendOne(token, chatId, chunk)
  }
  return lastResult
}

export async function sendMessageWithKeyboard(
  token: string,
  chatId: string,
  text: string,
  buttons: Array<{ text: string; callback_data: string }>,
): Promise<any> {
  const rows = buttons.map((b) => [b])
  return telegramApi(token, "sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: { inline_keyboard: rows },
  })
}

// SDD-02 Amendment A: send an inline keyboard from explicit rows, so a picker can
// place candidate buttons one-per-row and pack the Prev/Next controls onto a
// single trailing row. Callers own row shaping; this only forwards it.
export async function sendMessageWithButtonRows(
  token: string,
  chatId: string,
  text: string,
  rows: Array<Array<{ text: string; callback_data: string }>>,
): Promise<any> {
  return telegramApi(token, "sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: { inline_keyboard: rows },
  })
}

export async function editMessageReplyMarkup(
  token: string,
  chatId: string,
  messageId: number,
): Promise<void> {
  try {
    await telegramApi(token, "editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    })
  } catch {}
}

// SDD-04: edit an existing message's text (delivery loop / progress edits).
// Swallow the harmless "message is not modified" error so idempotent re-edits
// after a crash do not throw (W-19).
export async function editMessageText(
  token: string,
  chatId: string,
  messageId: number,
  text: string,
): Promise<void> {
  try {
    await telegramApi(token, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "Markdown",
    })
  } catch (err) {
    if (String(err).includes("message is not modified")) return
    // Same Markdown-parse fragility as sendMessage: retry as plain text so a
    // stray entity in the result never blocks delivery of the edit.
    if (isParseEntitiesError(err)) {
      try {
        await telegramApi(token, "editMessageText", { chat_id: chatId, message_id: messageId, text })
        return
      } catch (retryErr) {
        if (String(retryErr).includes("message is not modified")) return
        throw retryErr
      }
    }
    throw err
  }
}

export async function answerCallbackQuery(token: string, callbackQueryId: string, text?: string): Promise<void> {
  await telegramApi(token, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
  })
}

export async function getUpdates(token: string, offset?: number, timeout = 30): Promise<any[]> {
  const params: Record<string, unknown> = { timeout, allowed_updates: ["message", "callback_query"] }
  if (offset !== undefined) params.offset = offset
  return telegramApi(token, "getUpdates", params)
}
