import { ulid } from "ulid"
import { Queue } from "./queue"
import { TelegramStore } from "../telegram/store"
import { HeadlessSession } from "../daemon/headless"
import { Log } from "../util/log"

const log = Log.create({ service: "queue.worker" })

const DEFAULT_CAP = 3
const MAX_ATTEMPTS = 2
const DEFAULT_TICK_MS = 2000

// SDD-04: the in-daemon worker loop. Claims jobs from the durable queue and
// runs them through the HeadlessSession.run choke point, modeled on the
// scheduler drain/concurrency pattern. Per-chat ordering (CC-3) is enforced by
// excluding in-flight chats from the claim.
export namespace JobWorker {
  let _interval: ReturnType<typeof setInterval> | null = null
  let _running = false
  let _cap = DEFAULT_CAP
  let _workerId = ulid()
  let _activeJobs = new Map<string, Promise<void>>()
  let _inFlightChats = new Set<string>()
  let _deliveryHook: (() => void) | null = null

  export function setDeliveryHook(fn: (() => void) | null): void {
    _deliveryHook = fn
  }

  export async function start(opts?: { cap?: number; tickMs?: number }): Promise<void> {
    if (_running) return
    _cap = opts?.cap ?? DEFAULT_CAP
    _workerId = ulid()
    _running = true

    // W-27: recovery sweep BEFORE the first drain.
    try {
      Queue.recoverInterrupted(MAX_ATTEMPTS)
    } catch (err) {
      log.error("recovery sweep failed", { error: String(err) })
    }

    const tickMs = opts?.tickMs ?? DEFAULT_TICK_MS
    _interval = setInterval(() => {
      drain()
    }, tickMs)
    if (typeof _interval === "object" && "unref" in _interval) _interval.unref()

    log.info("queue worker started", { cap: _cap, workerId: _workerId })

    // Kick a delivery pass so recovered/errored jobs are delivered promptly.
    _deliveryHook?.()
    drain()
  }

  export async function stop(): Promise<void> {
    if (!_running && !_interval) return
    if (_interval) {
      clearInterval(_interval)
      _interval = null
    }
    _running = false

    if (_activeJobs.size > 0) {
      log.info("waiting for in-flight jobs", { count: _activeJobs.size })
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 30_000))
      await Promise.race([Promise.allSettled(Array.from(_activeJobs.values())), timeout])
      _activeJobs.clear()
    }
    _inFlightChats.clear()
    log.info("queue worker stopped")
  }

  /** Latency optimization: drain now and trigger one delivery pass. */
  export function nudge(): void {
    _deliveryHook?.()
    drain()
  }

  export function isRunning(): boolean {
    return _running
  }

  export function drain(): void {
    if (!_running) return
    // W-16: do not claim until the runner is wired.
    if (!HeadlessSession.hasRunner()) return

    while (_activeJobs.size < _cap && HeadlessSession.hasRunner()) {
      const job = Queue.claim(_workerId, Array.from(_inFlightChats))
      if (!job) break
      startJob(job)
    }
  }

  function startJob(job: Queue.Job): void {
    _inFlightChats.add(job.chat_id)
    const promise = runJob(job).finally(() => {
      _activeJobs.delete(job.id)
      _inFlightChats.delete(job.chat_id)
      // W-14: attempt to drain again as capacity frees up.
      _deliveryHook?.()
      drain()
    })
    _activeJobs.set(job.id, promise)
  }

  async function runJob(job: Queue.Job): Promise<void> {
    // Checkpoint: honor a cancel requested before we start running (W-25).
    if (Queue.isCancelRequested(job.id)) {
      Queue.markCanceled(job.id)
      return
    }

    Queue.markRunning(job.id)
    const payload = job.payload

    try {
      const result = await HeadlessSession.run({
        prompt: payload.prompt,
        persona: payload.persona,
        timeoutMs: payload.timeoutMs,
        sessionId: payload.sessionId,
        chatId: job.chat_id,
        model: payload.model,
        onSessionCreated: (sid) => {
          Queue.setSession(job.id, sid)
          if (job.chat_id) TelegramStore.setSession(job.chat_id, sid)
        },
      })

      // Checkpoint: if cancellation was requested while running, suppress the
      // result and report cancellation instead (W-25). markDone is guarded to
      // `running`, so markCanceled here wins.
      if (Queue.isCancelRequested(job.id)) {
        Queue.markCanceled(job.id)
        return
      }

      Queue.markDone(job.id, {
        response: result.response,
        sessionId: result.sessionId,
        toolCalls: result.toolCalls,
        durationMs: result.durationMs,
      })
    } catch (err) {
      if (Queue.isCancelRequested(job.id)) {
        Queue.markCanceled(job.id)
        return
      }
      const msg = err instanceof Error ? err.message : String(err)
      Queue.markError(job.id, msg)
      log.error("job failed", { jobId: job.id, error: msg })
    }
  }

  export function _reset(): void {
    if (_interval) {
      clearInterval(_interval)
      _interval = null
    }
    _running = false
    _cap = DEFAULT_CAP
    _activeJobs = new Map()
    _inFlightChats = new Set()
    _deliveryHook = null
  }
}
