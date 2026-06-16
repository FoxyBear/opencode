/**
 * Harness OS — ELT pipeline around the LLM
 *
 * Replaces the linear loop.before with a Collect→Classify→Transform→Route pipeline.
 * The harness can short-circuit the LLM for deterministic operations (status, peers,
 * memory queries) or route to a mesh peer. The LLM is one subsystem, not the whole pipeline.
 *
 * Foundational principle: agents are not code. The harness is code. Everything that
 * requires determinism, repeatability, or enforcement lives in the harness.
 */

import { AutoRecall } from "../memory/recall"
import { getConfig } from "../config/bridge"
import { Mesh } from "../mesh/mesh"
import { PersonaSession } from "../persona/session"
import { Router, type RouteDecision, type RouteContext } from "./router"
import { BuiltinHandlers } from "./handlers"
import { ToolPatterns } from "./patterns"
import { Embedding } from "../memory/embedding"
import { Log } from "../util/log"

const log = Log.create({ service: "harness" })

let _recallInjection: string | null = null
let _meshMessages: any[] = []
let _lastRouteDecision: RouteDecision | null = null
let _handlersRegistered = false

export type HarnessResult =
  | { route: "llm" }
  | { route: "harness"; handler: string; result: string }
  | { route: "peer"; target: string; result: string }

export interface HarnessDeps {
  getConfig: () => Promise<any>
  loadMessages: (sessionID: string) => Promise<any[]>
  microcompact: (input: { sessionID: string; messages: any[]; budgetPercent: number }) => Promise<{ cleared: number; tokensFreed: number }>
  autoRecall: (input: { query: string; persona: string; sessionID: string; project_id?: string; workforceUrl?: string }) => Promise<any[]>
  formatForInjection: (results: any[], opts?: { degraded?: boolean }) => string
  classify: (input: string, context: RouteContext) => Promise<RouteDecision>
}

const defaultDeps: HarnessDeps = {
  getConfig: () => getConfig(),
  loadMessages: (_sessionID) => Promise.resolve([]),
  microcompact: (_input) => Promise.resolve({ cleared: 0, tokensFreed: 0 }),
  autoRecall: (input) => AutoRecall.autoRecall(input),
  formatForInjection: (results, opts) => AutoRecall.formatForInjection(results, opts),
  classify: (input, context) => Router.classify(input, context),
}

export namespace Harness {
  export async function run(
    input: {
      sessionID: string
      isFirstIteration: boolean
    },
    deps: HarnessDeps = defaultDeps,
  ): Promise<HarnessResult> {
    const { sessionID, isFirstIteration } = input

    if (!_handlersRegistered) {
      BuiltinHandlers.register()
      _handlersRegistered = true
    }

    let cfg: any | undefined
    try {
      cfg = await deps.getConfig()
    } catch (e) {
      log.warn("harness: config unavailable, running with defaults", { error: String(e) })
    }

    // 1. MICROCOMPACT (runs on all iterations)
    try {
      const threshold = cfg?.compaction?.tier1_threshold ?? 0.7
      const messages = await deps.loadMessages(sessionID)
      await deps.microcompact({
        sessionID,
        messages,
        budgetPercent: threshold,
      })
    } catch (e) {
      log.error("harness: microcompaction failed", { sessionID, error: String(e) })
    }

    // 2. COLLECT: extract user input
    let userInput = ""
    if (isFirstIteration) {
      try {
        const messages = await deps.loadMessages(sessionID)
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i]
          if (msg?.info?.role === "user" && Array.isArray(msg.parts)) {
            const texts = msg.parts
              .filter((p: any) => p.type === "text" && typeof p.text === "string" && !p.synthetic)
              .map((p: any) => p.text)
            if (texts.length > 0) {
              userInput = texts.join(" ")
              break
            }
          }
        }
      } catch (e) {
        log.warn("harness: failed to extract user input", { error: String(e) })
      }
    }

    // 3. CLASSIFY: determine route (first iteration only)
    let routeDecision: RouteDecision = { route: "llm" }
    if (isFirstIteration && userInput) {
      try {
        const context: RouteContext = { sessionID, isFirstIteration, config: cfg }
        routeDecision = await deps.classify(userInput, context)
        _lastRouteDecision = routeDecision
        if (routeDecision.route !== "llm") {
          log.info("harness: routed directly", {
            route: routeDecision.route,
            handler: routeDecision.route === "harness" ? routeDecision.handler : undefined,
          })
        }
      } catch (e) {
        log.warn("harness: classification failed, defaulting to LLM", { error: String(e) })
        routeDecision = { route: "llm" }
      }
    }

    // 4. TRANSFORM: context enhancement (LLM route only)
    if (routeDecision.route === "llm" && isFirstIteration && cfg?.memory) {
      try {
        const personaName =
          PersonaSession.get(sessionID as any)?.name ??
          PersonaSession.getDefault()?.name ??
          "default"
        const results = await deps.autoRecall({
          query: userInput,
          persona: personaName,
          sessionID,
          workforceUrl: cfg.memory.workforce?.url,
        })
        const formatted = deps.formatForInjection(results)
        _recallInjection = formatted || null

        try {
          const embeddingConfig = cfg.memory.embedding
          if (embeddingConfig && userInput) {
            const embResult = await Embedding.embedSafe(userInput, {
              provider: embeddingConfig.provider ?? "deepinfra",
              model: embeddingConfig.model ?? "BAAI/bge-base-en-v1.5",
              dimensions: embeddingConfig.dimensions ?? 768,
            })
            if (embResult.ok) {
              const pattern = ToolPatterns.findMatchingPattern({
                queryEmbedding: embResult.value,
              })
              if (pattern && pattern.deterministic) {
                const prefetched = await ToolPatterns.prefetch(pattern)
                if (prefetched && prefetched.results.length > 0) {
                  const prefetchNote = formatPrefetchResults(prefetched)
                  _recallInjection = (_recallInjection ?? "") + "\n\n" + prefetchNote
                  log.info("harness: pre-fetched tool results injected", {
                    pattern: pattern.toolSequence.join(" → "),
                    results: prefetched.results.length,
                  })
                }
              }
            }
          }
        } catch (e) {
          log.warn("harness: pre-fetch failed", { error: String(e) })
        }
      } catch (e) {
        log.error("harness: auto-recall failed", { sessionID, error: String(e) })
        _recallInjection = null
      }
    } else if (routeDecision.route === "llm" && !isFirstIteration) {
      log.info("harness: skipping recall (tool loop iteration)", { sessionID })
    } else if (routeDecision.route === "llm" && !cfg?.memory) {
      log.info("harness: skipping recall (memory not configured)", { sessionID })
      _recallInjection = null
    }

    // 5. MESH CHECK (runs on all iterations)
    try {
      if (cfg?.mesh?.enabled) {
        const messages = Mesh.checkMessages()
        _meshMessages = messages
        if (messages.length > 0) {
          log.info("harness: mesh messages received", { sessionID, count: messages.length })
        }
      } else {
        _meshMessages = []
      }
    } catch (e) {
      log.error("harness: mesh check failed", { sessionID, error: String(e) })
      _meshMessages = []
    }

    return routeDecision
  }

  export function getRecallInjection(): string | null {
    return _recallInjection
  }

  export function getMeshMessages(): any[] {
    return _meshMessages
  }

  export function getLastRouteDecision(): RouteDecision | null {
    return _lastRouteDecision
  }

  export function reset(): void {
    _recallInjection = null
    _meshMessages = []
    _lastRouteDecision = null
  }
}

function formatPrefetchResults(prefetched: { results: Array<{ tool: string; output: string }>; staleness: string }): string {
  const lines = ["## Pre-fetched Tool Results (pattern match)"]
  lines.push(`> ${prefetched.staleness}. Results may be stale — re-fetch if needed.`)
  for (const r of prefetched.results) {
    lines.push(`### ${r.tool}`)
    lines.push(r.output.slice(0, 500))
  }
  return lines.join("\n")
}
