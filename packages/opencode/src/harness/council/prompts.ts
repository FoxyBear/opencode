import type { Disagreement, RevisionCheck } from "./ruling";

export type CouncilRole = "advocate" | "skeptic" | "analyst" | "synthesizer";

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
}

export interface RoleAssignment {
  model: ModelInfo;
  role: CouncilRole;
}

const ROLE_LABELS: Record<CouncilRole, string> = {
  advocate: "ADVOCATE — Argue FOR the proposal. Defend it. Find value, strengths, hidden benefits.",
  skeptic: "SKEPTIC — Argue AGAINST the proposal. Attack assumptions. Find weaknesses, risks, failure modes.",
  analyst: "ANALYST — Neutral evaluator. Compare alternatives. Quantify. Objective analysis only.",
  synthesizer: "SYNTHESIZER — Bridge opposing views. Find common ground. Integrate perspectives into solutions.",
};

export function assignRoles(models: ModelInfo[]): RoleAssignment[] {
  const roles: CouncilRole[] = ["advocate", "skeptic", "analyst", "synthesizer"];
  const shuffled = [...roles].sort(() => Math.random() - 0.5);
  return models.map((model, i) => ({
    model,
    role: shuffled[i % shuffled.length],
  }));
}

export function buildResearchPrompt(role: RoleAssignment, prompt: string): string {
  const label = ROLE_LABELS[role.role];
  return `Your role: ${label}

You are preparing for a council deliberation on the following topic:

"${prompt}"

## Research Phase

Use all available tools to gather evidence for your position. You have access to:
- File reading (project source code, documents, configuration)
- Web search (articles, documentation, benchmarks)
- Memory recall (previous conversations, decisions, ADRs)
- Code execution (run tests, benchmarks, analysis scripts)

Produce a concise evidence brief. For each claim you plan to make:
1. State the claim specifically
2. Provide supporting evidence (file references, URLs, data)
3. Note the strength of the evidence (verified vs. plausible vs. speculative)

Your evidence brief will be shared with you during the proposal phase. Focus on quality over quantity — the strongest 3-5 pieces of evidence are more valuable than a long list of weak citations.`;
}

export function buildProposalPrompt(role: RoleAssignment, researchBrief: string | undefined, prompt: string): string {
  const label = ROLE_LABELS[role.role];
  let systemPrompt = `Your role: ${label}\n\nYou are participating in a multi-model council deliberation on:\n\n"${prompt}"`;

  if (researchBrief) {
    systemPrompt += `\n\n## Your Research\n\n${researchBrief}`;
  }

  systemPrompt += `\n\n## Instructions\n\nPresent your proposal. Follow your role's stance (${role.role}). Be specific, evidence-based, and structured. Your output goes directly to the arbitrator — no meta-commentary, no addressing other models directly.`;

  return systemPrompt;
}

export function buildCritiquePrompt(
  reviewer: ModelInfo,
  reviewRole: string,
  targetProposal: string,
  targetName: string,
  allProposals: Array<{ modelName: string; proposal: string }>,
  originalPrompt: string
): string {
  const otherProposals = allProposals
    .filter((p) => p.modelName !== targetName)
    .map((p) => `## ${p.modelName}'s Proposal:\n${p.proposal}`)
    .join("\n\n");

  return `You are critically evaluating another model's proposal in a council deliberation. The original prompt was:

"${originalPrompt}"

## ${targetName}'s Proposal (the one you are critiquing):

${targetProposal}

## Other Proposals (for context):

${otherProposals}

## Your Task

Critically evaluate ${targetName}'s proposal. You MUST respond with a JSON object and nothing else — no preamble, no markdown code fences.

The JSON object must have these exact fields:
- "strengths": array of strings — what's good about this proposal
- "weaknesses": array of strings — what's wrong or missing
- "suggestions": array of strings — specific improvements to make
- "summary": string — brief overall assessment (1-3 sentences)

Be thorough and constructive. Focus on accuracy, completeness, and practical feasibility.`;
}

export function buildArbitratePrompt(
  proposals: Array<{ modelName: string; proposal: string }>,
  critiques: Array<{ reviewer: string; target: string; strengths: string[]; weaknesses: string[]; suggestions: string[] }>,
  originalPrompt: string,
  threshold: number,
  previousScores: number[] | undefined,
  roundNumber: number
): string {
  const proposalsText = proposals
    .map((p) => `## ${p.modelName}:\n${p.proposal}`)
    .join("\n\n");

  const critiquesText = critiques
    .slice(0, 15)
    .map((c) => `${c.reviewer} on ${c.target}: strengths=${c.strengths.join(", ").slice(0, 100)}; weaknesses=${c.weaknesses.join(", ").slice(0, 100)}`)
    .join("\n");

  let momentumText = "";
  if (roundNumber > 1 && previousScores && previousScores.length > 0) {
    momentumText = `\nPrevious convergence scores: ${previousScores.join(" → ")}.\n`;
    const last = previousScores[previousScores.length - 1];
    const prior = previousScores[previousScores.length - 2] ?? last;
    if (last > prior) {
      momentumText += "Convergence is improving. Consider extending if close to threshold.\n";
    } else if (last === prior && last < threshold) {
      momentumText += "Convergence is stalled. Consider concluding with a deadlock note.\n";
    }
  }

  return `You are the arbitrator of a multi-model deliberation council. The original prompt was:

"${originalPrompt}"

## Current Proposals (Round ${roundNumber}):

${proposalsText}

## Key Critiques:

${critiquesText}
${momentumText}
## Your Ruling

Evaluate the convergence of these proposals and provide a ruling. You MUST respond with a JSON object and nothing else — no preamble, no markdown code fences.

The JSON object must have these exact fields:
- "agreements": array of strings — points where all models agree
- "disagreements": array of objects, each with "point" (string), "positions" (object mapping model names to position), "ruling" (string — your decision), "rationale" (string — why)
- "directives": object mapping model names to specific revision instructions
- "synthesizedCritiques": object mapping model names to a consolidated summary of all critiques received
- "revisionChecks": array (rounds 2+ only) — for each model, evaluate revision quality. Each entry: "modelName" (string), "score" (number 1-5), "analysis" (string)
- "convergenceScore": number 1-5 — how converged the proposals are
- "converged": boolean — true if convergenceScore >= ${threshold}
- "reasoning": string — overall assessment
- "action": "continue" | "extend" | "conclude"

Action guidance:
- "continue" — Progress is being made but consensus is insufficient. Another round.
- "extend" — Convergence is close and trending upward. One more push.
- "conclude" — Consensus reached or deadlock confirmed. Synthesize final output.

Be decisive. For each disagreement, make a clear ruling. Your directives should be specific and actionable.`;
}

export function buildRevisePrompt(
  modelName: string,
  originalProposal: string,
  directive: string,
  synthesizedCritique: string,
  rulings: { agreements: string[]; disagreements: Disagreement[] },
  originalPrompt: string
): string {
  const agreementsText = rulings.agreements.length > 0
    ? `\n## Established Agreements\n${rulings.agreements.map((a) => `- ${a}`).join("\n")}`
    : "";

  const disagreementsText = rulings.disagreements.length > 0
    ? `\n## Disagreements with Rulings\n${rulings.disagreements.map((d) => `- ${d.point}: ${d.ruling} (${d.rationale})`).join("\n")}`
    : "";

  const critiqueText = synthesizedCritique
    ? `\n## Synthesized Critique of Your Proposal\n${synthesizedCritique}`
    : "";

  const directiveText = directive
    ? `\n## Your Revision Directive\n${directive}`
    : "";

  return `You are revising your proposal in a multi-model council deliberation. The original prompt was:

"${originalPrompt}"

## Your Previous Proposal

${originalProposal}
${critiqueText}${agreementsText}${disagreementsText}${directiveText}

## Instructions

Revise your proposal to:
1. Address the valid concerns in the synthesized critique
2. Respect the arbitrator's rulings on disagreements
3. Follow your revision directive
4. Maintain your original role's stance

Respond with your revised proposal directly — no preamble, no meta-commentary, just the improved proposal.`;
}

export function buildSynthesizePrompt(
  proposals: Array<{ modelName: string; proposal: string }>,
  critiques: Array<{ reviewer: string; target: string; strengths: string[]; weaknesses: string[]; suggestions: string[] }>,
  rulings: { agreements: string[]; disagreements: Disagreement[] },
  originalPrompt: string
): string {
  const proposalsText = proposals
    .map((p) => `## ${p.modelName}:\n${p.proposal}`)
    .join("\n\n");

  const agreementsText = rulings.agreements.length > 0
    ? `\n## Established Agreements\n${rulings.agreements.map((a) => `- ${a}`).join("\n")}`
    : "";

  const disagreementsText = rulings.disagreements.length > 0
    ? `\n## Disagreements with Rulings\n${rulings.disagreements.map((d) => `- ${d.point}: ${d.ruling} (${d.rationale})`).join("\n")}`
    : "";

  const keyCritiqueText = critiques
    .filter((c) => c.weaknesses.length > 0)
    .slice(0, 8)
    .map((c) => `${c.reviewer}: weaknesses in ${c.target} — ${c.weaknesses.join(", ").slice(0, 150)}`)
    .join("\n");

  return `You are the arbitrator synthesizing the final output of a multi-model deliberation council. The original prompt was:

"${originalPrompt}"

## Final Proposals

${proposalsText}
${agreementsText}${disagreementsText}

## Key Critiques from Deliberation

${keyCritiqueText}

## Instructions

Produce a comprehensive, well-structured final synthesis that:
1. Incorporates the best ideas from ALL proposals
2. Respects your rulings on disagreements
3. Addresses the weaknesses identified in critiques
4. Provides clear, actionable recommendations
5. Notes any remaining disagreements or minority opinions
6. Includes assumptions, uncertainties, and confidence levels where applicable

Output the final synthesis directly — no preamble, no meta-commentary.`;
}
