import z from "zod"
import { Effect } from "effect"
import { Tool } from "../../tool/tool"
import { runCouncil, type CouncilConfig, type SubAgentRunner, type DeliberationResult } from "./deliberation"
import { loadSettings, resolveModel } from "./config"
import { callModel, getApiKey } from "./transport"

function formatVerbose(result: DeliberationResult): string {
  const lines: string[] = []
  lines.push("")
  lines.push("=".repeat(60))
  lines.push("COUNCIL DELIBERATION")
  lines.push("=".repeat(60))
  lines.push(`Prompt: ${result.prompt}`)
  lines.push(`Consensus: ${result.consensusReached ? "Reached" : "Not reached"} | Rounds: ${result.totalRounds}`)
  lines.push("=".repeat(60))

  if (result.researchBriefs && Object.keys(result.researchBriefs).length > 0) {
    lines.push("\n## Research Briefs")
    for (const [model, brief] of Object.entries(result.researchBriefs)) {
      lines.push(`\n### ${model}`)
      lines.push(brief.slice(0, 500))
    }
  }

  for (const round of result.rounds) {
    lines.push(`\n--- Round ${round.roundNumber} ---`)

    lines.push("\n### Proposals")
    for (const proposal of round.proposals) {
      lines.push(`\n**${proposal.modelName}** (${proposal.role}):`)
      lines.push(proposal.content.slice(0, 400))
    }

    lines.push(`\n### Critiques: ${round.critiques.length} exchanged`)

    lines.push("\n### Arbitrator Ruling")
    if (round.ruling.parseError) {
      lines.push(`Parse error: ${round.ruling.reasoning}`)
    } else {
      lines.push(`Convergence: ${round.ruling.convergenceScore}/5 — ${round.ruling.converged ? "Consensus" : "No consensus"}`)
      lines.push(`Action: ${round.ruling.action}`)
      if (round.ruling.agreements.length > 0) lines.push(`Agreements: ${round.ruling.agreements.length}`)
      if (round.ruling.disagreements.length > 0) lines.push(`Disagreements ruled: ${round.ruling.disagreements.length}`)
    }
  }

  lines.push("")
  lines.push("=".repeat(60))
  lines.push("FINAL SYNTHESIS")
  lines.push("=".repeat(60))
  lines.push(result.finalSynthesis)
  return lines.join("\n")
}

export const CouncilTool = Tool.define(
  "council_deliberate",
  Effect.succeed({
    description:
      "Run multi-model council deliberation. Sends the prompt to multiple LLM providers (OpenAI, Anthropic, DeepInfra) who debate through proposals, critiques, arbitration, and synthesis. Use this for important decisions that benefit from diverse AI perspectives.",
    parameters: z.object({
      prompt: z.string().describe("The question or decision to deliberate on"),
      verbose: z.boolean().optional().describe("Include detailed round-by-round output"),
    }),
    execute: (params: { prompt: string; verbose?: boolean }, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const settings = loadSettings()
        const models = settings.models.map(resolveModel)
        const arbitrator = resolveModel(settings.arbitrator)
        const config: CouncilConfig = {
          models: models.slice(0, 4),
          arbitrator,
          maxRounds: settings.maxRounds,
          threshold: settings.threshold,
          enableResearch: settings.enableResearch,
        }

        const keyCache = new Map<string, string>()
        for (const m of [...models, arbitrator]) {
          if (!keyCache.has(m.provider)) {
            keyCache.set(m.provider, getApiKey(m.provider))
          }
        }

        const runner: SubAgentRunner = {
          async run(model, systemPrompt, userPrompt) {
            if (ctx.abort.aborted) throw new Error("Council cancelled")
            await Effect.runPromise(ctx.metadata({ title: `Council: ${model.name} responding...` }))
            const apiKey = keyCache.get(model.provider)!
            return callModel(model, apiKey, systemPrompt, userPrompt, ctx.abort)
          },
        }

        const result = yield* Effect.promise(() =>
          runCouncil(params.prompt, config, runner, (_phase, detail) => {
            Effect.runPromise(ctx.metadata({ title: `Council: ${detail}` })).catch(() => {})
          }),
        )

        const output = params.verbose ? formatVerbose(result) : result.finalSynthesis
        if (!result.consensusReached && !params.verbose) {
          return {
            title: "Council Deliberation",
            output: output + `\n\n[No consensus after ${result.totalRounds} rounds]`,
            metadata: { consensus: false, rounds: result.totalRounds },
          }
        }
        return {
          title: "Council Deliberation",
          output,
          metadata: { consensus: result.consensusReached, rounds: result.totalRounds },
        }
      }).pipe(Effect.orDie),
  }),
)
