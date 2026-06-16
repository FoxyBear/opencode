import fs from "fs/promises"
import path from "path"
import { Global } from "../global"
import { Log } from "../util/log"
import { validateSpec } from "../spec-pipeline/validator"

const log = Log.create({ service: "clean-room" })

export type RoomState =
  | "created" | "running" | "completed" | "failed" | "timeout"
  | "validated" | "validation_failed" | "reviewed" | "review_issues"
  | "merged" | "discarded"

export interface ValidationResult {
  step: "build" | "test" | "diff_bounds" | "spec_coverage"
  passed: boolean
  details: string
}

export interface Room {
  id: string
  spec_id: string
  spec_title: string
  spec_file: string
  worktree_path: string
  branch: string
  source_branch: string
  state: RoomState
  created_at: string
  session_id?: string
  duration_ms?: number
  diff_stat?: { files: number; insertions: number; deletions: number }
  validation_results?: ValidationResult[]
  review_issues?: string[]
}

export interface RoomConfig {
  max_session_timeout_ms: number
  max_files: number
  max_insertions: number
  build_command: string
  test_command: string
}

const DEFAULT_CONFIG: RoomConfig = {
  max_session_timeout_ms: 1_800_000,
  max_files: 50,
  max_insertions: 2000,
  build_command: "make build",
  test_command: "make test",
}

function getRoomsDir(): string {
  return path.join(Global.Path.data, "rooms")
}

function getArchiveDir(): string {
  return path.join(getRoomsDir(), "archive")
}

function roomFile(id: string): string {
  return path.join(getRoomsDir(), `${id}.json`)
}

async function saveRoom(room: Room): Promise<void> {
  await fs.mkdir(getRoomsDir(), { recursive: true })
  await fs.writeFile(roomFile(room.id), JSON.stringify(room, null, 2))
}

async function loadRoom(id: string): Promise<Room | null> {
  try {
    const raw = await fs.readFile(roomFile(id), "utf-8")
    return JSON.parse(raw) as Room
  } catch {
    return null
  }
}

export namespace CleanRoom {
  export async function create(specFile: string, opts?: { branch?: string; cwd?: string }): Promise<Room> {
    const cwd = opts?.cwd ?? process.cwd()

    const specContent = await fs.readFile(specFile, "utf-8")
    const validation = validateSpec(specContent)
    if (!validation.valid) {
      const errors = validation.errors.filter((e) => e.severity === "error").map((e) => e.message)
      throw new Error(`Spec validation failed: ${errors.join("; ")}`)
    }

    const titleMatch = specContent.match(/^#\s+(\S+)\s+—\s+(.+)/m)
    const specId = titleMatch?.[1] ?? "unknown"
    const specTitle = titleMatch?.[2] ?? path.basename(specFile, ".md")

    const roomId = `${specId}-${Date.now()}`
    const branchName = opts?.branch ?? `room/${specId}-${Date.now()}`

    const sourceBranch = await exec("git rev-parse --abbrev-ref HEAD", cwd)

    const worktreePath = path.join(cwd, ".worktrees", roomId)
    try {
      await exec(`git worktree add -b "${branchName}" "${worktreePath}"`, cwd)
    } catch (err) {
      throw new Error(`Failed to create worktree: ${err}`)
    }

    try {
      await fs.copyFile(specFile, path.join(worktreePath, "SPEC.md"))
    } catch (err) {
      await exec(`git worktree remove "${worktreePath}" --force`, cwd).catch(() => {})
      await exec(`git branch -D "${branchName}"`, cwd).catch(() => {})
      throw new Error(`Failed to copy spec: ${err}`)
    }

    const room: Room = {
      id: roomId,
      spec_id: specId,
      spec_title: specTitle,
      spec_file: specFile,
      worktree_path: worktreePath,
      branch: branchName,
      source_branch: sourceBranch,
      state: "created",
      created_at: new Date().toISOString(),
    }

    await saveRoom(room)
    log.info("room created", { id: roomId, worktree: worktreePath, branch: branchName })
    return room
  }

  export async function run(roomId: string, config?: Partial<RoomConfig>): Promise<Room> {
    const room = await loadRoom(roomId)
    if (!room) throw new Error(`Room not found: ${roomId}`)
    if (room.state !== "created") throw new Error(`Room ${roomId} is in state "${room.state}", expected "created"`)

    const cfg = { ...DEFAULT_CONFIG, ...config }
    room.state = "running"
    await saveRoom(room)

    const start = Date.now()
    try {
      const { HeadlessSession } = await import("../daemon/headless")
      const result = await HeadlessSession.run({
        prompt: `Implement the spec in SPEC.md. Follow TDD. Run verification commands from the spec. Report completion.`,
        timeoutMs: cfg.max_session_timeout_ms,
      })

      room.session_id = result.sessionId
      room.duration_ms = Date.now() - start
      room.state = "completed"
    } catch (err) {
      room.duration_ms = Date.now() - start
      room.state = String(err).includes("timed out") ? "timeout" : "failed"
    }

    try {
      const stat = await exec("git diff --stat", room.worktree_path)
      const files = (stat.match(/(\d+) files? changed/)?.[1] ?? "0")
      const insertions = (stat.match(/(\d+) insertions?/)?.[1] ?? "0")
      const deletions = (stat.match(/(\d+) deletions?/)?.[1] ?? "0")
      room.diff_stat = { files: Number(files), insertions: Number(insertions), deletions: Number(deletions) }
    } catch {}

    await saveRoom(room)
    return room
  }

  export async function validate(roomId: string, config?: Partial<RoomConfig>): Promise<Room> {
    const room = await loadRoom(roomId)
    if (!room) throw new Error(`Room not found: ${roomId}`)
    if (room.state !== "completed") throw new Error(`Room ${roomId} must be in "completed" state`)

    const cfg = { ...DEFAULT_CONFIG, ...config }
    const results: ValidationResult[] = []
    const wt = room.worktree_path

    try {
      await exec(cfg.build_command, wt)
      results.push({ step: "build", passed: true, details: "Build succeeded" })
    } catch (err) {
      results.push({ step: "build", passed: false, details: `Build failed: ${String(err).slice(0, 500)}` })
    }

    try {
      await exec(cfg.test_command, wt)
      results.push({ step: "test", passed: true, details: "Tests passed" })
    } catch (err) {
      results.push({ step: "test", passed: false, details: `Tests failed: ${String(err).slice(0, 500)}` })
    }

    const ds = room.diff_stat ?? { files: 0, insertions: 0, deletions: 0 }
    if (ds.files <= cfg.max_files && ds.insertions <= cfg.max_insertions) {
      results.push({ step: "diff_bounds", passed: true, details: `${ds.files} files, ${ds.insertions} insertions (within bounds)` })
    } else {
      results.push({ step: "diff_bounds", passed: false, details: `${ds.files} files (max ${cfg.max_files}), ${ds.insertions} insertions (max ${cfg.max_insertions})` })
    }

    try {
      const specContent = await fs.readFile(path.join(wt, "SPEC.md"), "utf-8")
      const ids = specContent.match(/\b([A-Z]{2,4}-\d{2})\b/g) ?? []
      const uniqueIds = [...new Set(ids)]

      const testOutput = await exec("grep -r -l 'test\\|describe' test/ src/**/__tests__/ 2>/dev/null || true", wt)
      const testContent = testOutput ? await Promise.all(
        testOutput.split("\n").filter(Boolean).map((f) => fs.readFile(path.join(wt, f), "utf-8").catch(() => "")),
      ).then((contents) => contents.join("\n")) : ""

      const uncovered = uniqueIds.filter((id) => !testContent.includes(id))
      if (uncovered.length === 0) {
        results.push({ step: "spec_coverage", passed: true, details: `All ${uniqueIds.length} statement IDs covered in tests` })
      } else {
        results.push({ step: "spec_coverage", passed: false, details: `Uncovered: ${uncovered.join(", ")}` })
      }
    } catch (err) {
      results.push({ step: "spec_coverage", passed: false, details: `Coverage check failed: ${String(err).slice(0, 200)}` })
    }

    room.validation_results = results
    room.state = results.every((r) => r.passed) ? "validated" : "validation_failed"
    await saveRoom(room)
    return room
  }

  export async function merge(roomId: string): Promise<Room> {
    const room = await loadRoom(roomId)
    if (!room) throw new Error(`Room not found: ${roomId}`)
    if (room.state !== "validated" && room.state !== "reviewed") {
      throw new Error(`Room ${roomId} must be "validated" or "reviewed" to merge (current: "${room.state}")`)
    }

    const cwd = path.dirname(room.worktree_path)

    await exec("git add -A", room.worktree_path)
    await exec(`git commit -m "Implement ${room.spec_id}: ${room.spec_title}"`, room.worktree_path)

    await exec(`git checkout "${room.source_branch}"`, cwd)
    await exec(`git merge "${room.branch}"`, cwd)

    await exec(`git worktree remove "${room.worktree_path}"`, cwd)

    room.state = "merged"
    await saveRoom(room)
    await archiveRoom(room)
    return room
  }

  export async function discard(roomId: string): Promise<Room> {
    const room = await loadRoom(roomId)
    if (!room) throw new Error(`Room not found: ${roomId}`)

    const cwd = path.dirname(room.worktree_path)

    try {
      await exec(`git worktree remove "${room.worktree_path}" --force`, cwd)
    } catch {}
    try {
      await exec(`git branch -D "${room.branch}"`, cwd)
    } catch {}

    room.state = "discarded"
    await saveRoom(room)
    await archiveRoom(room)
    return room
  }

  export async function list(): Promise<Room[]> {
    const dir = getRoomsDir()
    try {
      const files = await fs.readdir(dir)
      const rooms: Room[] = []
      for (const file of files) {
        if (!file.endsWith(".json")) continue
        try {
          const raw = await fs.readFile(path.join(dir, file), "utf-8")
          rooms.push(JSON.parse(raw) as Room)
        } catch {}
      }
      return rooms.sort((a, b) => b.created_at.localeCompare(a.created_at))
    } catch {
      return []
    }
  }

  export async function get(roomId: string): Promise<Room | null> {
    return loadRoom(roomId)
  }
}

async function archiveRoom(room: Room): Promise<void> {
  try {
    await fs.mkdir(getArchiveDir(), { recursive: true })
    await fs.writeFile(path.join(getArchiveDir(), `${room.id}.json`), JSON.stringify(room, null, 2))
    await fs.unlink(roomFile(room.id)).catch(() => {})
  } catch {}
}

async function exec(command: string, cwd: string): Promise<string> {
  const result = Bun.spawnSync(["sh", "-c", command], { cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString()
    throw new Error(stderr || `Command failed with exit code ${result.exitCode}`)
  }
  return result.stdout.toString().trim()
}
