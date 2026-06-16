import matter from "gray-matter"
import fs from "fs/promises"
import { Log } from "../util/log"

const log = Log.create({ service: "spec-pipeline" })

export interface RequirementDoc {
  id: string
  title: string
  objective: string
  constraints: string[]
  prior_art: Array<{ file: string; relevance: string }>
  dependencies: Array<{ spec_id: string; why: string }>
  scope: { in: string[]; out: string[] }
  context: string
}

export interface ValidationError {
  field: string
  message: string
}

const REQUIRED_FIELDS = ["id", "title", "objective"] as const

export function parseRequirement(raw: string): { doc: RequirementDoc; errors: ValidationError[] } {
  const errors: ValidationError[] = []
  let data: Record<string, any> = {}
  let content = ""

  try {
    const parsed = matter(raw)
    data = parsed.data
    content = parsed.content.trim()
  } catch (err) {
    return {
      doc: emptyDoc(),
      errors: [{ field: "format", message: `Failed to parse YAML frontmatter: ${err}` }],
    }
  }

  for (const field of REQUIRED_FIELDS) {
    if (!data[field] || (typeof data[field] === "string" && data[field].trim() === "")) {
      errors.push({ field, message: `Required field '${field}' is missing or empty` })
    }
  }

  const doc: RequirementDoc = {
    id: data.id ?? "",
    title: data.title ?? "",
    objective: data.objective ?? "",
    constraints: Array.isArray(data.constraints) ? data.constraints : [],
    prior_art: Array.isArray(data.prior_art)
      ? data.prior_art.map((p: any) => ({ file: p.file ?? "", relevance: p.relevance ?? "" }))
      : [],
    dependencies: Array.isArray(data.dependencies)
      ? data.dependencies.map((d: any) => ({ spec_id: d.spec_id ?? "", why: d.why ?? "" }))
      : [],
    scope: {
      in: Array.isArray(data.scope?.in) ? data.scope.in : [],
      out: Array.isArray(data.scope?.out) ? data.scope.out : [],
    },
    context: content,
  }

  return { doc, errors }
}

export async function validateRequirement(raw: string, specDir?: string): Promise<{ doc: RequirementDoc; errors: ValidationError[] }> {
  const { doc, errors } = parseRequirement(raw)

  if (specDir) {
    for (const dep of doc.dependencies) {
      try {
        const files = await fs.readdir(specDir)
        const found = files.some((f) => f.includes(dep.spec_id))
        if (!found) {
          errors.push({
            field: "dependencies",
            message: `Dependency spec '${dep.spec_id}' not found in ${specDir}`,
          })
        }
      } catch {
        errors.push({
          field: "dependencies",
          message: `Cannot read spec directory: ${specDir}`,
        })
      }
    }
  }

  return { doc, errors }
}

function emptyDoc(): RequirementDoc {
  return {
    id: "", title: "", objective: "", constraints: [], prior_art: [],
    dependencies: [], scope: { in: [], out: [] }, context: "",
  }
}
