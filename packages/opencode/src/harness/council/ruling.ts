export function extractJSON(raw: string): string {
  let text = raw.trim();

  try {
    JSON.parse(text);
    return text;
  } catch {}

  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    try {
      JSON.parse(fenceMatch[1].trim());
      return fenceMatch[1].trim();
    } catch {}
  }

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = text.slice(firstBrace, lastBrace + 1);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {}
  }

  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    const candidate = text.slice(firstBracket, lastBracket + 1);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {}
  }

  return text;
}

export type RulingAction = "continue" | "extend" | "conclude";

export interface Disagreement {
  point: string;
  positions: Record<string, string>;
  ruling: string;
  rationale: string;
}

export interface RevisionCheck {
  modelName: string;
  score: number;
  analysis: string;
}

export interface Ruling {
  agreements: string[];
  disagreements: Disagreement[];
  directives: Record<string, string>;
  synthesizedCritiques: Record<string, string>;
  revisionChecks: RevisionCheck[];
  convergenceScore: number;
  converged: boolean;
  action: RulingAction;
  reasoning: string;
  parseError: boolean;
  rawRuling?: string;
}

export function parseRuling(raw: string, threshold: number): Ruling {
  const extracted = extractJSON(raw);
  try {
    const parsed = JSON.parse(extracted);
    const score = typeof parsed.convergenceScore === "number" ? parsed.convergenceScore : 0;
    const action = validateAction(parsed.action);
    return {
      agreements: Array.isArray(parsed.agreements) ? parsed.agreements : [],
      disagreements: Array.isArray(parsed.disagreements)
        ? parsed.disagreements.map((d: any) => ({
            point: typeof d.point === "string" ? d.point : "",
            positions: typeof d.positions === "object" && d.positions !== null ? d.positions : {},
            ruling: typeof d.ruling === "string" ? d.ruling : "",
            rationale: typeof d.rationale === "string" ? d.rationale : "",
          }))
        : [],
      directives: typeof parsed.directives === "object" && parsed.directives !== null
        ? Object.fromEntries(
            Object.entries(parsed.directives).map(([k, v]) => [k, typeof v === "string" ? v : String(v)])
          )
        : {},
      synthesizedCritiques: typeof parsed.synthesizedCritiques === "object" && parsed.synthesizedCritiques !== null
        ? Object.fromEntries(
            Object.entries(parsed.synthesizedCritiques).map(([k, v]) => [k, typeof v === "string" ? v : String(v)])
          )
        : {},
      revisionChecks: Array.isArray(parsed.revisionChecks)
        ? parsed.revisionChecks.map((rc: any) => ({
            modelName: typeof rc.modelName === "string" ? rc.modelName : "",
            score: typeof rc.score === "number" ? rc.score : 0,
            analysis: typeof rc.analysis === "string" ? rc.analysis : "",
          }))
        : [],
      convergenceScore: score,
      converged: score >= threshold,
      action,
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
      parseError: false,
    };
  } catch {
    return {
      agreements: [],
      disagreements: [],
      directives: {},
      synthesizedCritiques: {},
      revisionChecks: [],
      convergenceScore: 0,
      converged: false,
      action: "conclude",
      reasoning: "Arbitrator response could not be parsed as JSON",
      rawRuling: raw,
      parseError: true,
    };
  }
}

function validateAction(raw: unknown): RulingAction {
  if (raw === "continue" || raw === "extend" || raw === "conclude") {
    return raw;
  }
  return "conclude";
}
