#!/usr/bin/env bun
//
// SDD pipeline driver — code-enforced Spec-Driven-Development gate.
//
// Stages run in strict order; each records a pass/fail artifact and the next
// stage refuses to run until the prior one passed:
//
//   author  ->  audit  ->  gate (human)  ->  implement <spec>  ->  verify <spec>
//
// The driver is deterministic: it enforces ordering, validates that the
// required artifacts exist and are well-formed (spec sections, audit/verify
// verdicts, build/test green), and records state. The judgment inside those
// artifacts is produced by agents; the gate around them is code.
//
// Usage (normally via `make sdd <stage> [arg]`):
//   bun run script/sdd/sdd.ts status
//   bun run script/sdd/sdd.ts author
//   bun run script/sdd/sdd.ts audit
//   bun run script/sdd/sdd.ts gate [yes]
//   bun run script/sdd/sdd.ts implement sdd-01
//   bun run script/sdd/sdd.ts verify sdd-01
//   bun run script/sdd/sdd.ts reset

import { $ } from "bun"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// ── Configuration ──

const DATE = "260719"
const PROJECT = "telegram"

interface SpecDef {
  id: string
  slug: string
  feature: boolean
}

const SPECS: SpecDef[] = [
  { id: "sdd-00", slug: "master", feature: false },
  { id: "sdd-01", slug: "durable-sessions", feature: true },
  { id: "sdd-02", slug: "model-control", feature: true },
  { id: "sdd-03", slug: "question-relay", feature: true },
  { id: "sdd-04", slug: "split-queue-worker-routing", feature: true },
]

const FEATURE_SPECS = SPECS.filter((s) => s.feature)

// Required section headers, checked case-insensitively as markdown headings.
const FEATURE_SECTIONS = ["WHAT", "HOW", "VERIFY"]
const MASTER_SECTIONS = ["Architecture", "Cross-Cutting", "Security", "Glossary", "Dependency"]

// ── Paths (resolved from the opencode git root so specs live in docs/specs) ──

const REPO_ROOT = (await $`git rev-parse --show-toplevel`.quiet().text()).trim()
const SPECS_DIR = join(REPO_ROOT, "docs", "specs")
const STATE_DIR = join(SPECS_DIR, ".sdd-state")
const STATE_FILE = join(STATE_DIR, "state.json")
const AUDIT_DIR = join(STATE_DIR, "audit")
const VERIFY_DIR = join(STATE_DIR, "verify")
const BASELINE_FAILURES_FILE = join(STATE_DIR, "baseline-failures.txt")

function specFile(spec: SpecDef): string {
  return join(SPECS_DIR, `${DATE}_${PROJECT}_${spec.id}-${spec.slug}.md`)
}

// ── State ──

type StageStatus = "pending" | "passed" | "failed"

interface State {
  stages: {
    author: { status: StageStatus; at?: string; detail?: string }
    audit: { status: StageStatus; at?: string; detail?: string }
    gate: { status: "pending" | "approved"; at?: string; approvedBy?: string }
  }
  implement: Record<string, { status: StageStatus; at?: string }>
  verify: Record<string, { status: StageStatus; at?: string }>
}

function emptyState(): State {
  return {
    stages: {
      author: { status: "pending" },
      audit: { status: "pending" },
      gate: { status: "pending" },
    },
    implement: {},
    verify: {},
  }
}

function loadState(): State {
  if (!existsSync(STATE_FILE)) return emptyState()
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8")) as State
  } catch {
    return emptyState()
  }
}

function saveState(state: State): void {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n")
}

function now(): string {
  // Date is unavailable in workflow scripts but fine in a normal bun script.
  return new Date().toISOString()
}

// ── Output helpers ──

const OK = "\x1b[32m✓\x1b[0m"
const NO = "\x1b[31m✗\x1b[0m"
const DASH = "\x1b[90m—\x1b[0m"

function die(msg: string): never {
  console.error(`${NO} ${msg}`)
  process.exit(1)
}

function pass(msg: string): void {
  console.log(`${OK} ${msg}`)
}

// ── Spec validation ──

function hasHeading(body: string, needle: string): boolean {
  // Match a markdown heading line containing the needle (case-insensitive).
  const re = new RegExp(`^#{1,6}\\s+.*${needle}`, "im")
  return re.test(body)
}

function validateSpec(spec: SpecDef): string[] {
  const problems: string[] = []
  const file = specFile(spec)
  if (!existsSync(file)) {
    problems.push(`missing spec file: ${file}`)
    return problems
  }
  const body = readFileSync(file, "utf-8")
  if (body.trim().length < 400) problems.push(`${spec.id}: spec is suspiciously short (<400 chars)`)

  if (spec.feature) {
    for (const section of FEATURE_SECTIONS) {
      if (!hasHeading(body, section)) problems.push(`${spec.id}: missing "## ${section}" section`)
    }
    // Behavioral specs must express WHEN/SHALL requirements.
    if (!/\bSHALL\b/.test(body)) problems.push(`${spec.id}: no SHALL requirements found`)
    if (!/\bWHEN\b/.test(body)) problems.push(`${spec.id}: no WHEN conditions found`)
  } else {
    for (const section of MASTER_SECTIONS) {
      if (!hasHeading(body, section)) problems.push(`${spec.id}: master missing a "${section}" section`)
    }
  }
  return problems
}

// ── Verdict artifacts (audit / verify reports) ──

function readVerdict(file: string): "PASS" | "FAIL" | null {
  if (!existsSync(file)) return null
  const body = readFileSync(file, "utf-8")
  const m = body.match(/^\s*VERDICT:\s*(PASS|FAIL)\s*$/im)
  if (!m) return null
  return m[1]!.toUpperCase() as "PASS" | "FAIL"
}

// ── Test failure parsing (tolerate known pre-existing baseline failures) ──

function loadBaselineFailures(): Set<string> {
  const set = new Set<string>()
  if (!existsSync(BASELINE_FAILURES_FILE)) return set
  for (const raw of readFileSync(BASELINE_FAILURES_FILE, "utf-8").split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    set.add(line)
  }
  return set
}

// Extract failing test names from `bun test` output: lines like
// "(fail) <name> [12.34ms]". Strips the trailing timing bracket.
function parseFailingTests(output: string): string[] {
  const names: string[] = []
  const re = /^\(fail\)\s+(.*?)(?:\s+\[[\d.]+ms\])?\s*$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(output)) !== null) names.push(m[1]!.trim())
  return names
}

// ── Commands ──

function cmdStatus(): void {
  const state = loadState()
  console.log(`\nSDD pipeline — ${PROJECT} (${DATE})`)
  console.log(`specs: ${SPECS_DIR}\n`)

  const stageLine = (name: string, status: string) => {
    const mark = status === "passed" || status === "approved" ? OK : status === "failed" ? NO : DASH
    console.log(`  ${mark} ${name.padEnd(12)} ${status}`)
  }
  stageLine("author", state.stages.author.status)
  stageLine("audit", state.stages.audit.status)
  stageLine("gate", state.stages.gate.status)

  console.log("\n  implement / verify (per spec):")
  for (const spec of FEATURE_SPECS) {
    const impl = state.implement[spec.id]?.status ?? "pending"
    const ver = state.verify[spec.id]?.status ?? "pending"
    const iMark = impl === "passed" ? OK : impl === "failed" ? NO : DASH
    const vMark = ver === "passed" ? OK : ver === "failed" ? NO : DASH
    console.log(`    ${spec.id}  impl ${iMark} ${impl.padEnd(8)}  verify ${vMark} ${ver}`)
  }
  console.log("")
}

function cmdAuthor(): void {
  const state = loadState()
  console.log("Validating spec suite structure...\n")
  const allProblems: string[] = []
  for (const spec of SPECS) {
    const problems = validateSpec(spec)
    if (problems.length === 0) pass(`${spec.id} (${spec.slug})`)
    else {
      console.log(`${NO} ${spec.id} (${spec.slug})`)
      for (const p of problems) console.log(`    - ${p}`)
      allProblems.push(...problems)
    }
  }
  if (allProblems.length > 0) {
    state.stages.author = { status: "failed", at: now(), detail: `${allProblems.length} problems` }
    saveState(state)
    die(`\nauthor stage FAILED (${allProblems.length} problems). Fix the specs and re-run.`)
  }
  state.stages.author = { status: "passed", at: now() }
  // Authoring changes invalidate downstream stages.
  state.stages.audit = { status: "pending" }
  state.stages.gate = { status: "pending" }
  saveState(state)
  console.log(`\n${OK} author stage PASSED — ${SPECS.length} specs present and well-formed.`)
}

function cmdAudit(): void {
  const state = loadState()
  if (state.stages.author.status !== "passed") die("audit blocked: author stage has not passed. Run `make sdd author` first.")

  mkdirSync(AUDIT_DIR, { recursive: true })
  console.log("Checking audit reports...\n")
  const missing: string[] = []
  const failed: string[] = []
  for (const spec of SPECS) {
    const report = join(AUDIT_DIR, `${spec.id}.md`)
    const verdict = readVerdict(report)
    if (verdict === null) {
      console.log(`${NO} ${spec.id}: no audit report with VERDICT: at ${report}`)
      missing.push(spec.id)
    } else if (verdict === "FAIL") {
      console.log(`${NO} ${spec.id}: audit VERDICT: FAIL`)
      failed.push(spec.id)
    } else {
      pass(`${spec.id}: audit VERDICT: PASS`)
    }
  }
  if (missing.length || failed.length) {
    state.stages.audit = { status: "failed", at: now(), detail: `missing=${missing.length} failed=${failed.length}` }
    saveState(state)
    die(`\naudit stage FAILED. Every spec needs an audit report with VERDICT: PASS before the human gate.`)
  }
  state.stages.audit = { status: "passed", at: now() }
  state.stages.gate = { status: "pending" }
  saveState(state)
  console.log(`\n${OK} audit stage PASSED — all ${SPECS.length} specs cleared independent audit.`)
}

async function cmdGate(arg?: string): Promise<void> {
  const state = loadState()
  if (state.stages.audit.status !== "passed") die("gate blocked: audit stage has not passed. Run `make sdd audit` first.")

  console.log("\nHUMAN GATE — review the specs and audit reports before any implementation.\n")
  console.log(`  specs:  ${SPECS_DIR}`)
  console.log(`  audits: ${AUDIT_DIR}\n`)

  let approved = arg === "yes" || arg === "--yes" || process.env["SDD_APPROVE"] === "1"
  if (!approved) {
    const answer = prompt("Approve the spec suite and unlock implementation? (yes/no)")
    approved = answer?.trim().toLowerCase() === "yes"
  }
  if (!approved) {
    console.log(`\n${DASH} gate NOT approved. Implementation remains locked.`)
    return
  }
  state.stages.gate = { status: "approved", at: now(), approvedBy: process.env["USER"] ?? "unknown" }
  saveState(state)
  console.log(`\n${OK} gate APPROVED by ${state.stages.gate.approvedBy}. Implementation unlocked.`)
}

function resolveSpec(arg?: string): SpecDef {
  if (!arg) die("this stage needs a spec id, e.g. `make sdd implement sdd-01`")
  const spec = FEATURE_SPECS.find((s) => s.id === arg)
  if (!spec) die(`unknown spec "${arg}". Feature specs: ${FEATURE_SPECS.map((s) => s.id).join(", ")}`)
  return spec
}

async function cmdImplement(arg?: string): Promise<void> {
  const spec = resolveSpec(arg)
  const state = loadState()
  if (state.stages.gate.status !== "approved") die("implement blocked: human gate not approved. Run `make sdd gate` first.")

  console.log(`Validating implementation of ${spec.id} — typecheck + tests must be green.\n`)

  console.log("→ typecheck")
  const tc = await $`bun run typecheck`.nothrow()
  if (tc.exitCode !== 0) {
    state.implement[spec.id] = { status: "failed", at: now() }
    saveState(state)
    die(`typecheck failed — ${spec.id} implementation is not green.`)
  }
  pass("typecheck")

  console.log("→ tests")
  const test = await $`bun test --timeout 30000`.nothrow()
  const output = test.stdout.toString() + "\n" + test.stderr.toString()
  const failing = parseFailingTests(output)
  const baseline = loadBaselineFailures()
  const newFailures = failing.filter((name) => !baseline.has(name))
  if (newFailures.length > 0) {
    state.implement[spec.id] = { status: "failed", at: now() }
    saveState(state)
    console.log("")
    for (const f of newFailures) console.log(`    ${NO} NEW failure: ${f}`)
    die(`${newFailures.length} NEW test failure(s) — ${spec.id} implementation is not green. Never leave broken tests.`)
  }
  if (test.exitCode !== 0 && failing.length === 0) {
    // Non-zero exit with no parseable (fail) lines means the run itself broke
    // (compile error in a test, crash) — treat as failure.
    state.implement[spec.id] = { status: "failed", at: now() }
    saveState(state)
    die(`test run exited ${test.exitCode} with no parseable failures — investigate (crash/compile error in tests).`)
  }
  const tolerated = failing.filter((name) => baseline.has(name))
  if (tolerated.length > 0) pass(`tests (no new failures; ${tolerated.length} known pre-existing baseline failure(s) tolerated)`)
  else pass("tests")

  state.implement[spec.id] = { status: "passed", at: now() }
  state.verify[spec.id] = { status: "pending" }
  saveState(state)
  console.log(`\n${OK} implement:${spec.id} PASSED — typecheck + tests green.`)
}

function cmdVerify(arg?: string): void {
  const spec = resolveSpec(arg)
  const state = loadState()
  if (state.implement[spec.id]?.status !== "passed") die(`verify blocked: implement:${spec.id} has not passed. Run \`make sdd implement ${spec.id}\` first.`)

  mkdirSync(VERIFY_DIR, { recursive: true })
  const report = join(VERIFY_DIR, `${spec.id}.md`)
  const verdict = readVerdict(report)
  if (verdict === null) die(`no verification report with VERDICT: at ${report}. Independent verifiers must run the mocked harness and record the result.`)
  if (verdict === "FAIL") {
    state.verify[spec.id] = { status: "failed", at: now() }
    saveState(state)
    die(`verification VERDICT: FAIL for ${spec.id}.`)
  }
  state.verify[spec.id] = { status: "passed", at: now() }
  saveState(state)
  console.log(`${OK} verify:${spec.id} PASSED — independent functional verification cleared.`)
}

function cmdReset(): void {
  saveState(emptyState())
  console.log(`${OK} pipeline state reset.`)
}

// ── Entrypoint ──

const [, , stage, arg] = process.argv

switch (stage) {
  case "status":
    cmdStatus()
    break
  case "author":
    cmdAuthor()
    break
  case "audit":
    cmdAudit()
    break
  case "gate":
    await cmdGate(arg)
    break
  case "implement":
    await cmdImplement(arg)
    break
  case "verify":
    cmdVerify(arg)
    break
  case "reset":
    cmdReset()
    break
  default:
    console.log("usage: sdd <status|author|audit|gate|implement <spec>|verify <spec>|reset>")
    process.exit(stage ? 1 : 0)
}
