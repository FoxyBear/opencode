import { cosineSimilarity } from "../memory/memory"
import { Log } from "../util/log"

const log = Log.create({ service: "harness.router" })

export interface RouteContext {
  sessionID: string
  isFirstIteration: boolean
  config: any
}

export interface HarnessHandler {
  name: string
  patterns: string[]
  description: string
  handler: (input: string, context: RouteContext) => Promise<string>
}

export type RouteDecision =
  | { route: "llm" }
  | { route: "harness"; handler: string; result: string }
  | { route: "peer"; target: string; result: string }

export interface RouterDeps {
  embed: (text: string) => Promise<Float32Array>
}

export namespace Router {
  let _handlers: HarnessHandler[] = []
  let _threshold = 0.8
  let _descriptionEmbeddings: Map<string, Float32Array> = new Map()

  export function register(handler: HarnessHandler): void {
    _handlers.push(handler)
  }

  export function unregister(name: string): void {
    _handlers = _handlers.filter((h) => h.name !== name)
    _descriptionEmbeddings.delete(name)
  }

  export function listHandlers(): HarnessHandler[] {
    return [..._handlers]
  }

  export function setThreshold(t: number): void {
    _threshold = t
  }

  export function getThreshold(): number {
    return _threshold
  }

  export async function classify(
    input: string,
    context: RouteContext,
    deps?: RouterDeps,
  ): Promise<RouteDecision> {
    if (!input || input.trim().length === 0) return { route: "llm" }

    const normalized = input.toLowerCase().trim()

    // Step 1: Pattern match (deterministic, <1ms)
    for (const handler of _handlers) {
      for (const pattern of handler.patterns) {
        if (normalized.includes(pattern.toLowerCase())) {
          try {
            log.info("router: pattern match", { handler: handler.name, pattern })
            const result = await handler.handler(input, context)
            return { route: "harness", handler: handler.name, result }
          } catch (err) {
            log.warn("router: handler failed, falling back to LLM", {
              handler: handler.name,
              error: String(err),
            })
            return { route: "llm" }
          }
        }
      }
    }

    // Step 2: Embedding similarity (near-zero ms after first embed)
    if (deps && _handlers.length > 0) {
      try {
        const inputEmbedding = await deps.embed(input)

        for (const handler of _handlers) {
          if (!_descriptionEmbeddings.has(handler.name)) {
            const emb = await deps.embed(handler.description)
            _descriptionEmbeddings.set(handler.name, emb)
          }
        }

        let bestHandler: HarnessHandler | null = null
        let bestScore = 0

        for (const handler of _handlers) {
          const descEmb = _descriptionEmbeddings.get(handler.name)
          if (!descEmb) continue
          const score = cosineSimilarity(inputEmbedding, descEmb)
          if (score > bestScore) {
            bestScore = score
            bestHandler = handler
          }
        }

        if (bestHandler && bestScore >= _threshold) {
          try {
            log.info("router: embedding match", {
              handler: bestHandler.name,
              score: bestScore.toFixed(3),
            })
            const result = await bestHandler.handler(input, context)
            return { route: "harness", handler: bestHandler.name, result }
          } catch (err) {
            log.warn("router: handler failed after embedding match, falling back to LLM", {
              handler: bestHandler.name,
              error: String(err),
            })
            return { route: "llm" }
          }
        }
      } catch (err) {
        log.warn("router: embedding classification failed", { error: String(err) })
      }
    }

    // Step 3: Default to LLM
    return { route: "llm" }
  }

  export function _reset(): void {
    _handlers = []
    _threshold = 0.8
    _descriptionEmbeddings = new Map()
  }
}
