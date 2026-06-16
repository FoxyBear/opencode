export interface SpecValidationResult {
  valid: boolean
  errors: Array<{ line: number; message: string; severity: "error" | "warning" }>
  stats: { statements: number; test_cases: number; sections: string[] }
}

const REQUIRED_SECTIONS = ["Objective", "Behavior", "Verification", "Boundaries"]
const WHEN_SHALL_PATTERN = /\*\*WHEN\*\*/

export function validateSpec(content: string): SpecValidationResult {
  const errors: SpecValidationResult["errors"] = []
  const lines = content.split("\n")

  const sections: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^##\s+(.+)/)
    if (match) sections.push(match[1].trim())
  }

  for (const req of REQUIRED_SECTIONS) {
    if (!sections.some((s) => s.includes(req))) {
      errors.push({ line: 0, message: `Missing required section: "${req}"`, severity: "error" })
    }
  }

  const statementIds = new Set<string>()
  let statementCount = 0
  let testCaseCount = 0
  let inBehavior = false
  let inVerification = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (line.startsWith("## Behavior")) inBehavior = true
    else if (line.startsWith("## ") && inBehavior) inBehavior = false
    if (line.startsWith("## Verification")) inVerification = true
    else if (line.startsWith("## ") && inVerification) inVerification = false

    if (inBehavior && WHEN_SHALL_PATTERN.test(line)) {
      statementCount++
    }

    if (inVerification && line.match(/^#\s+Test:|^\/\/\s+Test:/)) {
      testCaseCount++
    }
  }

  const idMatches = content.match(/\b([A-Z]{2,4}-\d{2})\b/g) ?? []
  for (const id of idMatches) {
    if (statementIds.has(id)) {
      errors.push({ line: 0, message: `Duplicate statement ID: ${id}`, severity: "error" })
    }
    statementIds.add(id)
  }

  if (statementCount === 0) {
    errors.push({ line: 0, message: "No WHEN/SHALL behavioral statements found", severity: "warning" })
  }

  return {
    valid: errors.filter((e) => e.severity === "error").length === 0,
    errors,
    stats: {
      statements: statementCount,
      test_cases: testCaseCount,
      sections,
    },
  }
}
