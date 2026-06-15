import type { ModelInfo } from "./prompts"
import { readFileSync, existsSync } from "fs"
import { resolve } from "path"
import { homedir } from "os"

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504])
const MAX_RETRIES = 3
const RETRY_DELAY_MS = 1000
const REQUEST_TIMEOUT_MS = 180_000

const ENV_KEYS: Record<string, string[]> = {
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  deepinfra: ["DEEPINFRA_API_KEY"],
}

const KEY_FILES: Record<string, string> = {
  OPENAI_API_KEY: ".openai_api.key",
  ANTHROPIC_API_KEY: ".anthropic.key",
  DEEPINFRA_API_KEY: ".deepinfra.key",
}

export function getApiKey(provider: string): string {
  const vars = ENV_KEYS[provider] ?? [`${provider.toUpperCase()}_API_KEY`]
  for (const v of vars) {
    if (process.env[v]) return process.env[v]!
    const filename = KEY_FILES[v]
    if (filename) {
      const keyPath = resolve(homedir(), "Development", filename)
      if (existsSync(keyPath)) {
        const key = readFileSync(keyPath, "utf-8").trim()
        if (key) return key
      }
    }
  }
  try {
    const authPath = resolve(homedir(), ".opencode", "data", "auth.json")
    const auth = JSON.parse(readFileSync(authPath, "utf-8"))
    if (auth[provider]?.type === "api" && auth[provider]?.key) return auth[provider].key
  } catch {}
  throw new Error(`No API key for provider "${provider}". Set ${vars[0]} or add ~/Development/${KEY_FILES[vars[0]] ?? vars[0] + ".key"}`)
}

async function retryFetch<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: Error | undefined
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * Math.pow(2, attempt - 1)))
      }
      return await fn()
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (lastError.name === "AbortError") throw lastError
      const statusMatch = lastError.message.match(/HTTP\s+(\d+)/)
      const isRetryable =
        lastError.message.includes("Network error") ||
        lastError.message.includes("timeout") ||
        lastError.message.includes("Too Many Requests") ||
        (statusMatch && RETRYABLE_STATUSES.has(parseInt(statusMatch[1])))
      if (!isRetryable) throw lastError
    }
  }
  throw lastError!
}

export async function callModel(
  model: ModelInfo,
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal,
): Promise<string> {
  if (model.provider === "anthropic") {
    return retryFetch(() => callAnthropic(model, apiKey, systemPrompt, userPrompt, signal))
  }
  return retryFetch(() => callOpenAICompatible(model, apiKey, systemPrompt, userPrompt, signal))
}

async function callOpenAICompatible(
  model: ModelInfo,
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const baseUrl =
    model.provider === "deepinfra"
      ? "https://api.deepinfra.com/v1/chat/completions"
      : "https://api.openai.com/v1/chat/completions"

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true })

  try {
    const response = await fetch(baseUrl, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model.id,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`${model.name} HTTP ${response.status}: ${body.slice(0, 300)}`)
    }

    const data = (await response.json()) as any
    const content = data.choices?.[0]?.message?.content
    if (!content) throw new Error(`No content in response from ${model.name}`)
    return content
  } finally {
    clearTimeout(timer)
  }
}

async function callAnthropic(
  model: ModelInfo,
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true })

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model.id,
        max_tokens: 32768,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`${model.name} HTTP ${response.status}: ${body.slice(0, 300)}`)
    }

    const data = (await response.json()) as any
    const content = data.content?.[0]?.text
    if (!content) throw new Error(`No content in response from ${model.name}`)
    return content
  } finally {
    clearTimeout(timer)
  }
}
