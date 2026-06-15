import { NamedError } from "@opencode-ai/util/error"
import z from "zod"
import { Effect, Layer, Context } from "effect"
import { Log } from "../util/log"

const log = Log.create({ service: "memory.embedding" })

// ── Effect Service Wrapper ──

export namespace EmbeddingService {
  export interface Interface {
    readonly embed: (text: string) => Effect.Effect<Float32Array>
    readonly embedBatch: (texts: string[]) => Effect.Effect<Float32Array[]>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/Embedding") {}

  export function makeLayer(config: Embedding.Config): Layer.Layer<Service> {
    return Layer.effect(
      Service,
      Effect.gen(function* () {
        const embed = Effect.fn("Embedding.embed")(function* (text: string) {
          return yield* Effect.promise(() => Embedding.embed(text, config))
        })

        const embedBatch = Effect.fn("Embedding.embedBatch")(function* (texts: string[]) {
          return yield* Effect.promise(() => Embedding.embedBatch(texts, config))
        })

        return Service.of({ embed, embedBatch })
      }),
    )
  }
}

export namespace Embedding {
  // ── Error Types ──

  export const EmbeddingUnavailableError = NamedError.create(
    "EmbeddingUnavailableError",
    z.object({
      message: z.string(),
      provider: z.string().optional(),
      cause: z.string().optional(),
    }),
  )

  export type EmbeddingUnavailableError = InstanceType<typeof EmbeddingUnavailableError>

  // ── Config ──

  export interface Config {
    provider: "ollama" | "deepinfra" | "openai"
    model: string
    dimensions: number
    fallback?: {
      provider: string
      model: string
    }
  }

  // ── Result type for safe operations ──

  type SafeResult<T> =
    | { ok: true; value: T }
    | { ok: false; error: EmbeddingUnavailableError }

  // ── Provider implementations ──

  async function embedOllama(text: string, model: string): Promise<Float32Array> {
    const response = await fetch("http://localhost:11434/api/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: text }),
    })
    if (!response.ok) {
      throw new Error(`Ollama returned ${response.status}: ${await response.text()}`)
    }
    const data = await response.json() as { embedding: number[] }
    return new Float32Array(data.embedding)
  }

  async function embedDeepInfra(text: string, model: string): Promise<Float32Array> {
    const apiKey = process.env.DEEPINFRA_API_KEY ?? ""
    const response = await fetch("https://api.deepinfra.com/v1/openai/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ input: text, model }),
    })
    if (!response.ok) {
      throw new Error(`DeepInfra returned ${response.status}: ${await response.text()}`)
    }
    const data = await response.json() as { data: { embedding: number[] }[] }
    return new Float32Array(data.data[0]!.embedding)
  }

  async function embedOpenAI(text: string, model: string): Promise<Float32Array> {
    const apiKey = process.env.OPENAI_API_KEY ?? ""
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ input: text, model }),
    })
    if (!response.ok) {
      throw new Error(`OpenAI returned ${response.status}: ${await response.text()}`)
    }
    const data = await response.json() as { data: { embedding: number[] }[] }
    return new Float32Array(data.data[0]!.embedding)
  }

  function getProviderFn(provider: string): (text: string, model: string) => Promise<Float32Array> {
    switch (provider) {
      case "ollama":
        return embedOllama
      case "deepinfra":
        return embedDeepInfra
      case "openai":
        return embedOpenAI
      default:
        throw new Error(`Unknown embedding provider: ${provider}`)
    }
  }

  // ── Public API ──

  // Max input tokens per embedding model. ~4 chars per token, use 3.5 for safety.
  const MODEL_MAX_TOKENS: Record<string, number> = {
    "BAAI/bge-base-en-v1.5": 8192,
    "nomic-embed-text": 8192,
    "text-embedding-3-small": 8191,
    "text-embedding-3-large": 8191,
  }
  const DEFAULT_MAX_TOKENS = 8192
  // Code tokenizes at ~2 chars/token (worse than prose at ~4).
  // Use 2.0 to be safe across all content types.
  const CHARS_PER_TOKEN = 2.0

  function maxCharsForModel(model: string): number {
    const tokens = MODEL_MAX_TOKENS[model] ?? DEFAULT_MAX_TOKENS
    return Math.floor(tokens * CHARS_PER_TOKEN)
  }

  /**
   * Embed text using the configured provider, with fallback support.
   * Throws EmbeddingUnavailableError if all providers fail.
   */
  export async function embed(text: string, config: Config): Promise<Float32Array> {
    const limit = maxCharsForModel(config.model)
    const truncated = text.length > limit ? text.slice(0, limit) : text
    const primaryFn = getProviderFn(config.provider)

    try {
      return await primaryFn(truncated, config.model)
    } catch (primaryError) {
      log.warn("primary embedding provider failed", {
        provider: config.provider,
        error: String(primaryError),
      })

      if (config.fallback) {
        try {
          const fallbackFn = getProviderFn(config.fallback.provider)
          return await fallbackFn(truncated, config.fallback.model)
        } catch (fallbackError) {
          log.error("fallback embedding provider also failed", {
            provider: config.fallback.provider,
            error: String(fallbackError),
          })
          throw new EmbeddingUnavailableError({
            message: `All embedding providers unavailable`,
            provider: `${config.provider},${config.fallback.provider}`,
            cause: String(fallbackError),
          })
        }
      }

      throw new EmbeddingUnavailableError({
        message: `Embedding provider unavailable: ${config.provider}`,
        provider: config.provider,
        cause: String(primaryError),
      })
    }
  }

  /**
   * Embed multiple texts sequentially.
   */
  export async function embedBatch(texts: string[], config: Config): Promise<Float32Array[]> {
    const results: Float32Array[] = []
    for (const text of texts) {
      results.push(await embed(text, config))
    }
    return results
  }

  /**
   * Safe variant that returns a result type instead of throwing.
   * Used when embedding failure should be handled gracefully (e.g., auto-recall skip).
   */
  export async function embedSafe(text: string, config: Config): Promise<SafeResult<Float32Array>> {
    try {
      const value = await embed(text, config)
      return { ok: true, value }
    } catch (error) {
      if (error instanceof EmbeddingUnavailableError) {
        return { ok: false, error }
      }
      return {
        ok: false,
        error: new EmbeddingUnavailableError({
          message: `Unexpected embedding error`,
          cause: String(error),
        }),
      }
    }
  }
}
