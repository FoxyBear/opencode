import type { RequirementDoc } from "./requirement"

export function generateSpecFromRequirement(doc: RequirementDoc, specNumber: string): string {
  const priorArt = doc.prior_art.length > 0
    ? doc.prior_art.map((p) => `- \`${p.file}\`: ${p.relevance}`).join("\n")
    : "None."

  const scopeOut = doc.scope.out.length > 0
    ? doc.scope.out.map((s) => `- ${s}`).join("\n")
    : "- (to be defined)"

  return `# ${specNumber} — ${doc.title}

## Objective

${doc.objective}

## Prior Art

${priorArt}

## Behavior

<!-- WHEN/SHALL behavioral statements go here -->
<!-- Each statement must be testable and follow the format: -->
<!-- **WHEN** <trigger>, it **SHALL** <behavior>. -->

## Interface Contract

\`\`\`typescript
// Types and interfaces for this spec
\`\`\`

## Harness Operations (automatic)

None.

## LLM-Callable Tools

None.

## Verification

\`\`\`bash
# Test commands
\`\`\`

## Boundaries

${scopeOut}
`
}

export function generateIndex(specs: Array<{ number: string; title: string; file: string; statements: number }>): string {
  const lines = ["# Spec Index", "", "| # | File | Title | Statements |", "|---|------|-------|-----------|"]
  for (const spec of specs) {
    lines.push(`| ${spec.number} | [${spec.file}](${spec.file}) | ${spec.title} | ${spec.statements} |`)
  }
  return lines.join("\n") + "\n"
}
