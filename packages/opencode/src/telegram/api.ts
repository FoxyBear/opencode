const BASE = "https://api.telegram.org/bot"

export async function telegramApi(token: string, method: string, body?: Record<string, unknown>): Promise<any> {
  const url = `${BASE}${token}/${method}`
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })

  const data = await res.json() as { ok: boolean; result?: any; description?: string }
  if (!data.ok) {
    throw new Error(`Telegram API error: ${data.description ?? res.status}`)
  }
  return data.result
}

export async function getMe(token: string): Promise<{ id: number; first_name: string; username?: string }> {
  return telegramApi(token, "getMe")
}

export async function sendMessage(token: string, chatId: string, text: string): Promise<any> {
  // Telegram has a 4096-char limit per message
  const MAX_LEN = 4096
  if (text.length <= MAX_LEN) {
    return telegramApi(token, "sendMessage", { chat_id: chatId, text, parse_mode: "Markdown" })
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
    lastResult = await telegramApi(token, "sendMessage", { chat_id: chatId, text: chunk })
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
