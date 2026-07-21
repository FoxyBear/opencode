#!/usr/bin/env bun
/**
 * Upstream sync monitor — scans OpenCode upstream for changes worth cherry-picking.
 *
 * Usage:
 *   bun run packages/opencode/script/upstream-sync.ts
 *   bun run packages/opencode/script/upstream-sync.ts --since 2026-06-01
 *   bun run packages/opencode/script/upstream-sync.ts --area session
 */

import { $ } from "bun"

const args = process.argv.slice(2)
const sinceIdx = args.indexOf("--since")
const sinceDate = sinceIdx !== -1 ? args[sinceIdx + 1] : undefined
const areaIdx = args.indexOf("--area")
const areaFilter = areaIdx !== -1 ? args[areaIdx + 1] : undefined

const CORE_PATHS = [
  "packages/opencode/src/session/",
  "packages/opencode/src/tool/",
  "packages/opencode/src/question/",
  "packages/opencode/src/permission/",
  "packages/opencode/src/provider/",
  "packages/opencode/src/config/",
  "packages/opencode/src/server/",
  "packages/opencode/src/cli/",
  "packages/opencode/src/mcp/",
  "packages/opencode/src/plugin/",
  "packages/opencode/src/lsp/",
  "packages/opencode/src/file/",
  "packages/opencode/src/project/",
  "packages/opencode/src/agent/",
  "packages/opencode/src/skill/",
]

interface Commit {
  hash: string
  subject: string
  date: string
  files: string[]
}

type Priority = "critical" | "high" | "medium" | "low"
type Category = "fix" | "feat" | "refactor" | "chore" | "docs"

interface Classified {
  commit: Commit
  category: Category
  priority: Priority
  area: string
  reason: string
  hasConflictRisk: boolean
}

function classify(c: Commit): Classified {
  const subject = c.subject.toLowerCase()

  const category: Category = subject.startsWith("fix") ? "fix"
    : subject.startsWith("feat") ? "feat"
    : subject.startsWith("refactor") ? "refactor"
    : subject.startsWith("docs") ? "docs"
    : "chore"

  const coreFiles = c.files.filter((f) => CORE_PATHS.some((p) => f.startsWith(p)))
  const area = coreFiles.length > 0
    ? coreFiles[0].split("/")[3] ?? "core"
    : c.files[0]?.split("/").slice(0, 3).join("/") ?? "root"

  const isSecurity = subject.includes("security") || subject.includes("xss") || subject.includes("inject")
  const isQuestion = coreFiles.some((f) => f.includes("question"))
  const isSession = coreFiles.some((f) => f.includes("session/"))
  const isProvider = coreFiles.some((f) => f.includes("provider/"))
  const isTool = coreFiles.some((f) => f.includes("tool/"))
  const isPermission = coreFiles.some((f) => f.includes("permission/"))

  let priority: Priority = "low"
  let reason = ""

  if (isSecurity) {
    priority = "critical"
    reason = "security fix"
  } else if (category === "fix" && (isQuestion || isPermission)) {
    priority = "critical"
    reason = "bug fix in user-facing interaction"
  } else if (category === "fix" && isSession) {
    priority = "high"
    reason = "session bug fix"
  } else if (category === "fix" && (isProvider || isTool)) {
    priority = "high"
    reason = "provider/tool bug fix"
  } else if (category === "fix") {
    priority = "medium"
    reason = "bug fix"
  } else if (category === "feat" && isProvider) {
    priority = "medium"
    reason = "new provider/model support"
  } else if (category === "refactor" && coreFiles.length > 5) {
    priority = "low"
    reason = "broad refactor — high conflict risk"
  } else if (category === "chore" && subject.includes("generate")) {
    priority = "low"
    reason = "generated code"
  } else {
    reason = `${category} in ${area}`
  }

  const hasConflictRisk = coreFiles.length > 0

  return { commit: c, category, priority, area, reason, hasConflictRisk }
}

async function main() {
  await $`git fetch upstream dev --quiet`.quiet()

  const base = (await $`git merge-base HEAD upstream/dev`.text()).trim()
  const sinceArg = sinceDate ? `--since=${sinceDate}` : ""

  const logArgs = ["git", "log", "--format=%H|%ai|%s", `${base}..upstream/dev`]
  if (sinceArg) logArgs.push(sinceArg)

  const logOutput = (await $`${logArgs}`.text()).trim()
  if (!logOutput) {
    console.log("No new upstream commits.")
    return
  }

  const lines = logOutput.split("\n").filter(Boolean)
  const commits: Commit[] = []

  for (const line of lines) {
    const [hash, date, ...rest] = line.split("|")
    const subject = rest.join("|")
    const files = (await $`git diff-tree --no-commit-id --name-only -r ${hash}`.text())
      .trim()
      .split("\n")
      .filter(Boolean)
    commits.push({ hash: hash.slice(0, 11), subject, date: date.slice(0, 10), files })
  }

  let classified = commits.map(classify)

  if (areaFilter) {
    classified = classified.filter((c) => c.area.includes(areaFilter))
  }

  const byPriority: Record<Priority, Classified[]> = {
    critical: [],
    high: [],
    medium: [],
    low: [],
  }
  for (const c of classified) {
    byPriority[c.priority].push(c)
  }

  const total = classified.length
  console.log(`\n=== Upstream Sync Report ===`)
  console.log(`Base: ${base.slice(0, 11)}`)
  console.log(`Commits: ${total} (${byPriority.critical.length} critical, ${byPriority.high.length} high, ${byPriority.medium.length} medium, ${byPriority.low.length} low)\n`)

  for (const priority of ["critical", "high", "medium"] as Priority[]) {
    const items = byPriority[priority]
    if (items.length === 0) continue

    const label = priority === "critical" ? "🔴 CRITICAL" : priority === "high" ? "🟠 HIGH" : "🟡 MEDIUM"
    console.log(`${label} (${items.length})`)
    console.log("─".repeat(60))
    for (const c of items) {
      const conflict = c.hasConflictRisk ? " ⚠️" : ""
      console.log(`  ${c.commit.hash} ${c.commit.subject}`)
      console.log(`    ${c.reason}${conflict} | ${c.commit.date} | ${c.area}`)
    }
    console.log()
  }

  if (byPriority.low.length > 0) {
    console.log(`⚪ LOW (${byPriority.low.length} — suppressed, run with --area to filter)`)
  }

  if (byPriority.critical.length > 0 || byPriority.high.length > 0) {
    console.log(`\n💡 Cherry-pick candidates:`)
    for (const c of [...byPriority.critical, ...byPriority.high]) {
      console.log(`  git cherry-pick ${c.commit.hash}  # ${c.commit.subject.slice(0, 60)}`)
    }
  }
}

main().catch(console.error)
