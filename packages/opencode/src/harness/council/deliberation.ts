import {
  assignRoles,
  buildProposalPrompt,
  buildCritiquePrompt,
  buildArbitratePrompt,
  buildRevisePrompt,
  buildSynthesizePrompt,
  buildResearchPrompt,
  type ModelInfo,
  type RoleAssignment,
} from "./prompts";
export type { ModelInfo } from "./prompts";
export type { Ruling } from "./ruling";
import { parseRuling, extractJSON, type Ruling } from "./ruling";

export interface CouncilConfig {
  models: ModelInfo[];
  arbitrator: ModelInfo;
  maxRounds: number;
  threshold: number;
  enableResearch: boolean;
}

export interface Proposal {
  modelName: string;
  role: string;
  content: string;
}

export interface CritiqueResult {
  reviewer: string;
  target: string;
  strengths: string[];
  weaknesses: string[];
  suggestions: string[];
  summary: string;
}

export interface RoundResult {
  roundNumber: number;
  proposals: Proposal[];
  critiques: CritiqueResult[];
  ruling: Ruling;
}

export interface DeliberationResult {
  prompt: string;
  researchBriefs: Record<string, string>;
  rounds: RoundResult[];
  finalSynthesis: string;
  consensusReached: boolean;
  totalRounds: number;
}

export interface SubAgentRunner {
  run(model: ModelInfo, systemPrompt: string, userPrompt: string, tools?: string[]): Promise<string>;
}

function parseCritiqueResponse(raw: string): { strengths: string[]; weaknesses: string[]; suggestions: string[]; summary: string } {
  try {
    const parsed = JSON.parse(extractJSON(raw));
    return {
      strengths: Array.isArray(parsed.strengths) ? parsed.strengths : [],
      weaknesses: Array.isArray(parsed.weaknesses) ? parsed.weaknesses : [],
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
      summary: typeof parsed.summary === "string" ? parsed.summary : raw.slice(0, 200),
    };
  } catch {
    return { strengths: [], weaknesses: [], suggestions: [], summary: raw.slice(0, 200) };
  }
}

export async function runCouncil(
  prompt: string,
  config: CouncilConfig,
  runner: SubAgentRunner,
  onProgress?: (phase: string, detail: string) => void
): Promise<DeliberationResult> {
  const assignments = assignRoles(config.models);

  // Phase 0: Research (optional)
  const researchBriefs: Record<string, string> = {};
  if (config.enableResearch) {
    for (const assignment of assignments) {
      onProgress?.("research", `${assignment.model.name} is researching...`);
      const researchPrompt = buildResearchPrompt(assignment, prompt);
      const result = await runner.run(
        assignment.model,
        researchPrompt,
        "Research this topic and produce an evidence brief.",
        ["read", "websearch", "memory", "bash"]
      );
      researchBriefs[assignment.model.name] = result;
      onProgress?.("research", `${assignment.model.name} — research complete (${result.length} chars)`);
    }
  }

  // Phase 1: Proposal + Phase 2: Deliberation
  const rounds: RoundResult[] = [];
  const previousScores: number[] = [];
  let currentProposals: Proposal[] = [];
  let currentCritiques: CritiqueResult[] = [];

  // Round 1: Initial proposals
  onProgress?.("round", `Round 1 — proposals`);
  const proposalResults = await Promise.all(
    assignments.map(async (assignment) => {
      const brief = researchBriefs[assignment.model.name];
      const proposalPrompt = buildProposalPrompt(assignment, brief, prompt);
      const content = await runner.run(assignment.model, proposalPrompt, "Present your proposal.");
      return {
        modelName: assignment.model.name,
        role: assignment.role,
        content,
      } satisfies Proposal;
    })
  );
  currentProposals = proposalResults;

  // Round 1: Critiques
  onProgress?.("round", `Round 1 — critiques`);
  const critiqueResults = await Promise.all(
    assignments.flatMap((reviewer) =>
      assignments
        .filter((target) => target.model.id !== reviewer.model.id)
        .map(async (target) => {
          const targetProposal = proposalResults.find((p) => p.modelName === target.model.name)?.content ?? "";
          const critiquePrompt = buildCritiquePrompt(
            reviewer.model,
            reviewer.role,
            targetProposal,
            target.model.name,
            proposalResults.map((p) => ({ modelName: p.modelName, proposal: p.content })),
            prompt
          );
          const raw = await runner.run(reviewer.model, critiquePrompt, `Critique ${target.model.name}'s proposal.`);
          const parsed = parseCritiqueResponse(raw);
          return {
            reviewer: reviewer.model.name,
            target: target.model.name,
            strengths: parsed.strengths,
            weaknesses: parsed.weaknesses,
            suggestions: parsed.suggestions,
            summary: parsed.summary,
          } satisfies CritiqueResult;
        })
    )
  );
  currentCritiques = critiqueResults;

  // Round 1: Arbitrate
  onProgress?.("round", `Round 1 — arbitrator`);
  const arbitrateResult1 = await runner.run(
    config.arbitrator,
    buildArbitratePrompt(
      proposalResults.map((p) => ({ modelName: p.modelName, proposal: p.content })),
      critiqueResults,
      prompt,
      config.threshold,
      undefined,
      1
    ),
    "Evaluate the council's proposals and issue your ruling."
  );
  const ruling1 = parseRuling(arbitrateResult1, config.threshold);
  previousScores.push(ruling1.convergenceScore);
  rounds.push({ roundNumber: 1, proposals: currentProposals, critiques: currentCritiques, ruling: ruling1 });

  let latestRuling = ruling1;

  if (latestRuling.converged || latestRuling.action === "conclude") {
    onProgress?.("round", latestRuling.converged ? `Consensus reached in round 1` : `Concluded by arbitrator in round 1`);
    const synthesis = await runner.run(
      config.arbitrator,
      buildSynthesizePrompt(
        currentProposals.map((p) => ({ modelName: p.modelName, proposal: p.content })),
        currentCritiques,
        { agreements: latestRuling.agreements, disagreements: latestRuling.disagreements },
        prompt
      ),
      "Synthesize the final output."
    );
    return { prompt, researchBriefs, rounds, finalSynthesis: synthesis, consensusReached: latestRuling.converged, totalRounds: 1 };
  }

  // Rounds 2+: Revise → Critique → Arbitrate
  for (let roundNum = 2; roundNum <= config.maxRounds; roundNum++) {
    onProgress?.("round", `Round ${roundNum} — revise & critique`);

    // Revise
    currentProposals = await Promise.all(
      assignments.map(async (assignment) => {
        const myProposal = currentProposals.find((p) => p.modelName === assignment.model.name)?.content ?? "";
        const directive = latestRuling.directives[assignment.model.id] ?? "";
        const synthesizedCritique = latestRuling.synthesizedCritiques[assignment.model.id] ?? "";
        const revisePrompt = buildRevisePrompt(
          assignment.model.name,
          myProposal,
          directive,
          synthesizedCritique,
          { agreements: latestRuling.agreements, disagreements: latestRuling.disagreements },
          prompt
        );
        const content = await runner.run(assignment.model, revisePrompt, `Revise your proposal for round ${roundNum}.`);
        return { modelName: assignment.model.name, role: assignment.role, content };
      })
    );

    // Critique
    currentCritiques = await Promise.all(
      assignments.flatMap((reviewer) =>
        assignments
          .filter((target) => target.model.id !== reviewer.model.id)
          .map(async (target) => {
            const targetProposal = currentProposals.find((p) => p.modelName === target.model.name)?.content ?? "";
            const critiquePrompt = buildCritiquePrompt(
              reviewer.model,
              reviewer.role,
              targetProposal,
              target.model.name,
              currentProposals.map((p) => ({ modelName: p.modelName, proposal: p.content })),
              prompt
            );
            const raw = await runner.run(reviewer.model, critiquePrompt, `Critique ${target.model.name}'s revised proposal.`);
            const parsed = parseCritiqueResponse(raw);
            return {
              reviewer: reviewer.model.name,
              target: target.model.name,
              strengths: parsed.strengths,
              weaknesses: parsed.weaknesses,
              suggestions: parsed.suggestions,
              summary: parsed.summary,
            } satisfies CritiqueResult;
          })
      )
    );

    // Arbitrate
    onProgress?.("round", `Round ${roundNum} — arbitrator`);
    const arbitrateResult = await runner.run(
      config.arbitrator,
      buildArbitratePrompt(
        currentProposals.map((p) => ({ modelName: p.modelName, proposal: p.content })),
        currentCritiques,
        prompt,
        config.threshold,
        previousScores,
        roundNum
      ),
      `Evaluate the council's round ${roundNum} proposals and issue your ruling.`
    );

    const ruling = parseRuling(arbitrateResult, config.threshold);
    previousScores.push(ruling.convergenceScore);
    rounds.push({ roundNumber: roundNum, proposals: currentProposals, critiques: currentCritiques, ruling });
    latestRuling = ruling;

    if (ruling.converged || ruling.action === "conclude") {
      break;
    }
  }

  // Phase 3: Synthesize
  onProgress?.("synthesize", "Producing final synthesis");
  const finalSynthesis = await runner.run(
    config.arbitrator,
    buildSynthesizePrompt(
      currentProposals.map((p) => ({ modelName: p.modelName, proposal: p.content })),
      currentCritiques,
      {
        agreements: rounds[rounds.length - 1].ruling.agreements,
        disagreements: rounds[rounds.length - 1].ruling.disagreements,
      },
      prompt
    ),
    "Synthesize the final output."
  );

  return {
    prompt,
    researchBriefs,
    rounds,
    finalSynthesis,
    consensusReached: rounds[rounds.length - 1].ruling.converged,
    totalRounds: rounds.length,
  };
}
