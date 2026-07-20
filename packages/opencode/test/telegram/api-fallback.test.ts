// Regression test for a bug found by the live smoke test: sendMessage/editMessageText
// force parse_mode "Markdown", so any text with an unbalanced Markdown entity
// (e.g. a session id "ses_..." with a lone underscore, or LLM output with a stray
// `*`/`_`/backtick) is rejected by Telegram with "Bad Request: can't parse
// entities" and the reply is silently lost. The fix: on a parse-entities error,
// retry the SAME text as plain (no parse_mode) so delivery always succeeds.

import { afterEach, expect, test } from "bun:test"
import { sendMessage, editMessageText, __setTransport } from "../../src/telegram/api"

interface Call {
  method: string
  parseMode: unknown
  text: unknown
}

// A fake transport that mimics Telegram: it REJECTS a Markdown parse when the
// text contains an unbalanced underscore, exactly as the real API does.
function fakeTransport(record: Call[]) {
  return async (_token: string, method: string, body?: Record<string, unknown>) => {
    const parseMode = body?.["parse_mode"]
    const text = body?.["text"]
    record.push({ method, parseMode, text })
    if (parseMode === "Markdown" && typeof text === "string" && /_/.test(text)) {
      throw new Error(
        "Telegram API error: Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 12",
      )
    }
    return { message_id: 1, chat: { id: 1 } }
  }
}

afterEach(() => __setTransport(null))

test("sendMessage retries as plain text when Markdown parse fails (session-id underscore)", async () => {
  const calls: Call[] = []
  __setTransport(fakeTransport(calls))

  // "Session: ses_07f9..." — the lone underscore breaks Markdown, as in /status.
  await sendMessage("tok", "chat1", "Session: ses_07f9c6873ffe\nModel: deepinfra/x\nPersona: katya")

  // First attempt Markdown (rejected), then a plain-text retry (succeeds).
  expect(calls.length).toBe(2)
  expect(calls[0]!.parseMode).toBe("Markdown")
  expect(calls[1]!.parseMode).toBeUndefined()
  expect(calls[1]!.text).toContain("ses_07f9c6873ffe")
})

test("sendMessage sends once with Markdown when text parses cleanly", async () => {
  const calls: Call[] = []
  __setTransport(fakeTransport(calls))
  await sendMessage("tok", "chat1", "all good, no underscores here")
  expect(calls.length).toBe(1)
  expect(calls[0]!.parseMode).toBe("Markdown")
})

test("editMessageText retries as plain text when Markdown parse fails", async () => {
  const calls: Call[] = []
  __setTransport(fakeTransport(calls))
  await editMessageText("tok", "chat1", 42, "result: value_with_underscore")
  expect(calls.length).toBe(2)
  expect(calls[0]!.parseMode).toBe("Markdown")
  expect(calls[1]!.parseMode).toBeUndefined()
})

test("editMessageText still swallows the harmless 'message is not modified' error", async () => {
  __setTransport(async () => {
    throw new Error("Telegram API error: Bad Request: message is not modified")
  })
  // Must not throw.
  await editMessageText("tok", "chat1", 42, "same text")
})
