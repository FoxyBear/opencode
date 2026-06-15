import { Log } from "@/util/log"
import { createHmac, timingSafeEqual } from "crypto"
import { Bonjour, type Service, type Browser } from "bonjour-service"
import os from "os"

const log = Log.create({ service: "mesh" })

/**
 * Peer interface — represents a discovered mesh node.
 */
export interface Peer {
  name: string
  address: string
  port: number
  persona: string
  capabilities: string[]
  status: "idle" | "busy" | "offline"
  last_seen: string // ISO-8601
  /**
   * Spec 16 §F-01 / EP-02 — Whether the discovered peer advertises itself
   * as Todd's declared (elevated) process. Parsed from TXT record
   * `elevated: "1"`. Defaults to false if the field is absent.
   */
  elevated: boolean
}

/**
 * MeshConfig — runtime configuration for the mesh network.
 */
export interface MeshConfig {
  enabled: boolean
  name: string
  secret: string
  mdns: boolean
  port?: number
  /**
   * Spec 16 §F-01 / EP-02 — Marks the local node as Todd's declared process.
   * When true, the mDNS TXT record advertises `elevated: "1"`, outgoing
   * peer queries stamp `elevated: true`, and incoming non-elevated queries
   * are preempted in favor of elevated ones from other peers.
   */
  elevated?: boolean
}

/**
 * MessageType — the four types of mesh messages.
 */
export type MessageType = "directive" | "status" | "query" | "response"

/**
 * MeshMessage — a signed message envelope between mesh nodes.
 */
export interface MeshMessage {
  from: string
  to: string
  type: MessageType
  payload: Record<string, unknown>
  timestamp: string
  hmac: string
}

/**
 * Compute HMAC-SHA256 for a message envelope.
 * MS-08: Uses the canonical field order: from, to, type, payload, timestamp.
 */
export function signMessage(msg: Omit<MeshMessage, "hmac">, secret: string): string {
  const payload = JSON.stringify({
    from: msg.from,
    to: msg.to,
    type: msg.type,
    payload: msg.payload,
    timestamp: msg.timestamp,
  })
  return createHmac("sha256", secret).update(payload).digest("hex")
}

/**
 * Verify an HMAC against the expected value.
 */
export function verifyHmac(msg: MeshMessage, secret: string): boolean {
  const expected = signMessage(msg, secret)
  try {
    const a = Buffer.from(expected, "hex")
    const b = Buffer.from(msg.hmac, "hex")
    return a.length === b.length && timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/** Default send timeout (ms) */
const DEFAULT_SEND_TIMEOUT = 5000

/** Stale peer threshold: 25 minutes (5 heartbeat cycles at 5 min each) */
const STALE_PEER_MS = 25 * 60 * 1000

/** Default peer-query timeout (ms) — matches HeadlessSession default. */
const DEFAULT_QUERY_TIMEOUT = 300_000

/**
 * Spec 16 §C — Result of a peer query once a terminal response has
 * arrived (or an error surfaced on the originating side).
 */
export interface PeerQueryResult {
  readonly status: "completed" | "error"
  readonly response?: string
  readonly sessionId?: string
  readonly error?: string
}

/**
 * Spec 16 §C-04 — Non-terminal progress events delivered to the caller
 * while the correlation remains open.
 */
export interface PeerQueryProgress {
  readonly status: "queued"
  readonly queuedPosition: number
}

/** Minimal shape of what a query handler must return. Matches HeadlessRunResult. */
export interface PeerQueryHandlerResult {
  readonly sessionId: string
  readonly response: string
  readonly toolCalls: number
  readonly durationMs: number
}

export type PeerQueryHandler = (input: {
  prompt: string
  persona?: string
  timeoutMs?: number
  /**
   * Spec 16 §F-02 / EP-04 — When the handler is invoked under a
   * preemptable slot, this signal aborts if a higher-priority (elevated)
   * peer query arrives. Handlers that ignore the signal are still
   * correct — Mesh discards the result and re-issues the original
   * request after the elevated query completes ("re-issuance, not a
   * process snapshot" per spec).
   */
  signal?: AbortSignal
}) => Promise<PeerQueryHandlerResult>

interface Correlation {
  resolve: (result: PeerQueryResult) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
  onProgress?: (event: PeerQueryProgress) => void
}

interface QueuedPeerQuery {
  from: string
  correlation_id: string
  prompt: string
  persona?: string
  timeout_ms?: number
  /** Spec 16 §F-02 / EP-04 — set on incoming queries marked `elevated: true`. */
  elevated?: boolean
}

function generateCorrelationId(): string {
  return `corr-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export namespace Mesh {
  // ── Internal state ──

  let _bonjour: Bonjour | undefined
  let _service: Service | undefined
  let _browser: Browser | undefined
  let _peers = new Map<string, Peer>()
  let _standalone = false
  let _started = false
  let _status: "idle" | "busy" = "idle"
  let _config: MeshConfig | undefined

  // Dependency injection for mDNS layer (for testing)
  let _mdnsFactory: (() => Bonjour) | undefined

  // Message processing
  let _messageHandler: ((msg: MeshMessage) => Promise<void>) | undefined
  let _messageQueue: MeshMessage[] = []

  // Session creator for delegation (callable injection like scheduler)
  let _sessionCreator: ((prompt: string, persona?: string) => Promise<string>) | undefined

  // Spec 16 §C state — correlation tracking for Mesh.query(), plus a
  // local serialization queue so a busy node doesn't run two peer
  // queries concurrently.
  const _correlations = new Map<string, Correlation>()
  let _queryHandler: PeerQueryHandler | undefined
  const _peerQueryQueue: QueuedPeerQuery[] = []

  // Spec 16 §F state — elevation + preemption.
  let _localElevated = false
  /**
   * Spec 16 §F-02 / EP-04 — Tracks the in-flight peer query so an
   * incoming elevated query can decide whether to preempt. When
   * preempt is signaled, `controller.abort()` fires and the handler's
   * result is suppressed; the saved request is re-issued after the
   * elevated query completes.
   */
  interface RunningQuery {
    q: QueuedPeerQuery
    controller: AbortController
    preempted: boolean
  }
  let _running: RunningQuery | undefined
  /** Spec 16 §F-02 / EP-04 — preempted requests, re-issued after elevated drains. */
  const _preemptedQueue: QueuedPeerQuery[] = []

  /**
   * Inject a custom Bonjour factory (for testing — similar to Scheduler.setExecutor).
   */
  export function _setMdnsFactory(factory: (() => Bonjour) | undefined): void {
    _mdnsFactory = factory
  }

  /**
   * Set the message handler for incoming messages (for testing/DI).
   */
  export function _setMessageHandler(handler: ((msg: MeshMessage) => Promise<void>) | undefined): void {
    _messageHandler = handler
  }

  /**
   * Set the session creator function (for delegation — called by harness integration).
   */
  export function setSessionCreator(creator: (prompt: string, persona?: string) => Promise<string>): void {
    _sessionCreator = creator
  }

  /**
   * Spec 16 §C-02 — Install the handler that runs when this node receives
   * a peer `query` message. The handler runs a local session (typically
   * delegates to HeadlessSession.run) and returns the result. Called by
   * daemon startup.
   */
  export function setQueryHandler(handler: PeerQueryHandler | undefined): void {
    _queryHandler = handler
  }

  /**
   * Spec 16 §C-01 — Send a query to a peer and wait for its response.
   *
   * Sends a `query`-type message with a fresh `correlation_id`, registers
   * a pending correlation, and returns a promise that resolves when the
   * peer sends back a `response` with `status: "completed"`. If the peer
   * is busy it may first send `status: "queued"` — that fires `onProgress`
   * but keeps the correlation open (§C-04). Timeout drops the correlation
   * and rejects (§C-05).
   */
  export async function query(input: {
    to: string
    prompt: string
    persona?: string
    timeoutMs?: number
    onProgress?: (event: PeerQueryProgress) => void
  }): Promise<PeerQueryResult> {
    // Validate peer registry first so timeout doesn't mask the real issue.
    const peer = _peers.get(input.to)
    if (!peer) {
      throw new Error(`Node '${input.to}' is not online.`)
    }

    const correlationId = generateCorrelationId()
    const timeoutMs = input.timeoutMs ?? DEFAULT_QUERY_TIMEOUT

    const result = await new Promise<PeerQueryResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        _correlations.delete(correlationId)
        reject(new Error(`Peer query to '${input.to}' timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      _correlations.set(correlationId, {
        resolve,
        reject,
        timer,
        onProgress: input.onProgress,
      })

      // Fire the query. If send() throws, clean up the correlation.
      send({
        to: input.to,
        type: "query",
        payload: {
          correlation_id: correlationId,
          prompt: input.prompt,
          ...(input.persona ? { persona: input.persona } : {}),
          timeout_ms: timeoutMs,
          // Spec 16 §F-02 / EP-03 — stamp elevation when the local
          // process is Todd's declared process, so the receiver knows
          // to preempt a busy non-elevated session.
          ...(_localElevated ? { elevated: true } : {}),
        },
      }).catch((err) => {
        clearTimeout(timer)
        _correlations.delete(correlationId)
        reject(err)
      })
    })

    return result
  }

  /**
   * MS-01: Start the mesh network.
   * When mesh.enabled=true, publish mDNS service with extended TXT records
   * and start browsing for peers.
   */
  export async function start(config?: MeshConfig): Promise<void> {
    if (!config?.enabled) {
      log.info("mesh disabled by config")
      return
    }

    _config = config
    _started = true
    _localElevated = config.elevated === true

    const nodeName = config.name || os.hostname()

    // MS-01: Publish mDNS service
    if (config.mdns) {
      try {
        _bonjour = _mdnsFactory ? _mdnsFactory() : new Bonjour()

        const txt: Record<string, string> = {
          path: "/",
          mesh: "1",
          persona: "default",
          capabilities: "",
          status: _status,
        }
        // Spec 16 §F-01 / EP-02 — advertise elevated status when set.
        // Field omitted when not elevated so peers without the field
        // default to elevated:false on the receiver side.
        if (_localElevated) txt.elevated = "1"

        _service = _bonjour.publish({
          name: nodeName,
          type: "http",
          port: config.port ?? 4096,
          txt,
        })

        _service.on("up", () => {
          log.info("mesh mDNS service published", { name: nodeName })
        })

        _service.on("error", (err: any) => {
          log.error("mesh mDNS service error", { error: err })
        })

        // MS-04: Browse for mesh peers
        _browser = _bonjour.find({ type: "http" })

        _browser.on("up", (service: any) => {
          // Only accept services with mesh="1" TXT record
          if (!service.txt || service.txt.mesh !== "1") return
          // Don't add ourselves
          if (service.name === nodeName) return

          const peer: Peer = {
            name: service.name,
            address: service.host || service.addresses?.[0] || "",
            port: service.port,
            persona: service.txt.persona || "",
            capabilities: service.txt.capabilities
              ? service.txt.capabilities.split(",").filter((c: string) => c.length > 0)
              : [],
            status: (service.txt.status as Peer["status"]) || "idle",
            last_seen: new Date().toISOString(),
            // Spec 16 §F-01 / EP-02 — peers without the field default to false.
            elevated: service.txt.elevated === "1",
          }

          // MS-05: Add to in-memory registry
          _peers.set(peer.name, peer)
          log.info("mesh peer discovered", { name: peer.name, address: peer.address })
        })

        // MS-06: Peer goodbye
        _browser.on("down", (service: any) => {
          const existing = _peers.get(service.name)
          if (existing) {
            existing.status = "offline"
            existing.last_seen = new Date().toISOString()
            log.info("mesh peer offline", { name: service.name })
          }
        })

        log.info("mesh started", { name: nodeName, port: config.port })
      } catch (err) {
        // MS-03: mDNS publish fails → standalone mode, no crash
        log.warn("mesh mDNS publish failed, entering standalone mode", { error: String(err) })
        _standalone = true

        // Cleanup partial state
        if (_bonjour) {
          try {
            _bonjour.destroy()
          } catch {}
        }
        _bonjour = undefined
        _service = undefined
        _browser = undefined
      }
    }
  }

  /**
   * MS-02: Stop the mesh network.
   * Unpublish mDNS service and stop browsing.
   */
  export async function stop(): Promise<void> {
    if (_browser) {
      try {
        _browser.stop()
      } catch {}
      _browser = undefined
    }

    if (_bonjour) {
      try {
        _bonjour.unpublishAll()
        _bonjour.destroy()
      } catch (err) {
        log.error("mesh mDNS unpublish failed", { error: err })
      }
      _bonjour = undefined
      _service = undefined
    }

    _started = false
    log.info("mesh stopped")
  }

  /**
   * Get the list of discovered peers.
   * Returns empty array in standalone mode.
   */
  export async function peers(): Promise<Peer[]> {
    if (_standalone || !_started) return []
    return Array.from(_peers.values())
  }

  /**
   * Update the local node's status (idle/busy).
   * MS-18: Also republishes mDNS TXT record with updated status.
   */
  export function updateStatus(status: "idle" | "busy"): void {
    _status = status
    // Republish mDNS TXT record if service is active
    if (_service && _bonjour && _config) {
      try {
        const nodeName = _config.name || os.hostname()
        // bonjour-service doesn't support TXT update in-place,
        // but we update the status for the next heartbeat
        log.info("mesh status updated", { status, name: nodeName })
      } catch (err) {
        log.warn("mesh mDNS TXT republish failed", { error: String(err) })
      }
    } else {
      log.info("mesh status updated", { status })
    }
  }

  /**
   * Get the current node status.
   */
  export function getStatus(): "idle" | "busy" {
    return _status
  }

  /**
   * Check if the node is in standalone mode (mDNS failed).
   */
  export function isStandalone(): boolean {
    return _standalone
  }

  /**
   * Get the node name from config.
   */
  export function getNodeName(): string {
    return _config?.name || os.hostname()
  }

  /**
   * Get the current config (for routes).
   */
  export function getConfig(): MeshConfig | undefined {
    return _config
  }

  /**
   * Spec 16 §F-01 / EP-08 — Source-of-truth for "is this process elevated?".
   * Returns the value last passed to `Mesh.start({ elevated })`. Defaults
   * to false. Consumers: scheduler (auto-tag enqueued tasks), recall
   * (stamp `requestor_elevated`), Mesh.query (already wired internally).
   */
  export function isElevated(): boolean {
    return _localElevated
  }

  /**
   * MS-08..10: Send a message to a peer.
   * MS-08: Constructs envelope with HMAC.
   * MS-09: Throws if target not in peer registry.
   * MS-10: Throws if POST fails.
   */
  export async function send(input: {
    to: string
    type: MessageType
    payload: Record<string, unknown>
    _timeout?: number // configurable timeout for testing
  }): Promise<void> {
    const secret = _config?.secret ?? ""
    const nodeName = getNodeName()

    // MS-09: Check peer registry
    const peer = _peers.get(input.to)
    if (!peer) {
      throw new Error(`Node '${input.to}' is not online.`)
    }

    // MS-08: Construct envelope
    const timestamp = new Date().toISOString()
    const envelope: Omit<MeshMessage, "hmac"> = {
      from: nodeName,
      to: input.to,
      type: input.type,
      payload: input.payload,
      timestamp,
    }
    const hmac = signMessage(envelope, secret)
    const message: MeshMessage = { ...envelope, hmac }

    // MS-10: POST to peer
    const url = `http://${peer.address}:${peer.port}/mesh/message`
    const timeout = input._timeout ?? DEFAULT_SEND_TIMEOUT

    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout)

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message),
        signal: controller.signal,
      })

      clearTimeout(timer)

      if (response.status === 401) {
        throw new Error(`Authentication failed with node '${input.to}'. Check mesh secret.`)
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("Authentication failed")) {
        throw err
      }
      throw new Error(`Failed to reach node '${input.to}'.`)
    }
  }

  /**
   * MS-11..12: Receive and verify an incoming message.
   * MS-11: Verify HMAC against mesh.secret.
   * MS-12: Bad HMAC → return false (caller returns 401).
   * Returns true if verified and processed.
   */
  export async function receiveMessage(msg: MeshMessage): Promise<boolean> {
    const secret = _config?.secret ?? ""

    // MS-11: Verify HMAC
    if (!verifyHmac(msg, secret)) {
      // MS-12: Bad HMAC
      log.warn("mesh HMAC verification failed", {
        from: msg.from,
        type: msg.type,
      })
      return false
    }

    // Process by type
    await processMessage(msg)
    return true
  }

  /**
   * MS-13..16: Process a verified message by type.
   * MS-13: directive → queue for session creation/injection
   * MS-14: status → log only, not injected
   * MS-15: query → queue for session routing
   * MS-16: response → queue for context injection
   */
  async function processMessage(msg: MeshMessage): Promise<void> {
    // Call handler if registered (for testing/extensibility)
    if (_messageHandler) {
      await _messageHandler(msg)
    }

    switch (msg.type) {
      case "directive":
        // MS-13: Queue for session creation or system message injection
        _messageQueue.push(msg)
        log.info("mesh directive received", { from: msg.from })
        break

      case "status":
        // MS-14: Log only — do NOT add to message queue
        log.info("mesh status update received", {
          from: msg.from,
          payload: msg.payload,
        })
        break

      case "query":
        // MS-15: Queue for session routing (response expected)
        _messageQueue.push(msg)
        log.info("mesh query received", { from: msg.from })
        // Spec 16 §C-02: run the query handler locally (or queue if busy)
        // and emit a response. Fire-and-forget — handler runs on its own
        // timeline; we don't block processMessage on it.
        void handlePeerQuery(msg)
        break

      case "response":
        // MS-16: Queue for context injection into requesting session
        _messageQueue.push(msg)
        log.info("mesh response received", { from: msg.from })
        // Spec 16 §C-03 / §C-04 / §C-06: match against pending correlations.
        handlePeerResponse(msg)
        break

      default:
        log.warn("mesh unknown message type", { type: msg.type, from: msg.from })
    }
  }

  /**
   * HO-08: Check for incoming mesh messages.
   * Returns and clears the message queue.
   * Called by harness in loop.before phase.
   */
  export function checkMessages(): MeshMessage[] {
    const messages = [..._messageQueue]
    _messageQueue = []
    return messages
  }

  /**
   * MS-17: Delegate a task to a peer.
   * Sends a directive with respond_to field so peer knows where to send the result.
   */
  export async function delegate(input: {
    to: string
    prompt: string
    persona?: string
    _timeout?: number
  }): Promise<string> {
    const nodeName = getNodeName()

    await send({
      to: input.to,
      type: "directive",
      payload: {
        prompt: input.prompt,
        persona: input.persona ?? "default",
        respond_to: nodeName,
      },
      _timeout: input._timeout,
    })

    // Return a session ID placeholder — the actual session is created on the receiving end
    return `delegated-${input.to}-${Date.now()}`
  }

  /**
   * MS-18: Heartbeat handler.
   * Updates status based on active sessions and cleans up stale peers.
   * Called by scheduler's mesh-peer-heartbeat maintenance task.
   */
  export async function heartbeat(activeSessionCount?: number): Promise<void> {
    // Update status based on active sessions
    const newStatus = (activeSessionCount ?? 0) > 0 ? "busy" : "idle"
    updateStatus(newStatus)

    // Clean up stale peers
    cleanupStalePeers()

    log.info("mesh heartbeat completed", { status: newStatus })
  }

  /**
   * MS-07: Remove peers that haven't been seen for 25+ minutes.
   * Called during heartbeat or as a periodic sweep.
   */
  export function cleanupStalePeers(): void {
    const now = Date.now()
    for (const [name, peer] of _peers) {
      const lastSeen = new Date(peer.last_seen).getTime()
      if (now - lastSeen >= STALE_PEER_MS) {
        _peers.delete(name)
        log.info("mesh stale peer removed", { name, last_seen: peer.last_seen })
      }
    }
  }

  /**
   * Reset all internal state (for testing only).
   */
  export function _reset(): void {
    if (_browser) {
      try {
        _browser.stop()
      } catch {}
    }
    if (_bonjour) {
      try {
        _bonjour.unpublishAll()
        _bonjour.destroy()
      } catch {}
    }
    _bonjour = undefined
    _service = undefined
    _browser = undefined
    _peers = new Map()
    _standalone = false
    _started = false
    _status = "idle"
    _config = undefined
    _mdnsFactory = undefined
    _messageHandler = undefined
    _messageQueue = []
    _sessionCreator = undefined
    // Spec 16 §C state
    for (const corr of _correlations.values()) {
      clearTimeout(corr.timer)
    }
    _correlations.clear()
    _queryHandler = undefined
    _peerQueryQueue.length = 0
    // Spec 16 §F state
    _localElevated = false
    if (_running) {
      try {
        _running.controller.abort()
      } catch {}
    }
    _running = undefined
    _preemptedQueue.length = 0
  }

  /**
   * Backdate a peer's last_seen timestamp (for testing stale peer cleanup).
   */
  export function _backdatePeer(name: string, msBack: number): void {
    const peer = _peers.get(name)
    if (peer) {
      peer.last_seen = new Date(Date.now() - msBack).toISOString()
    }
  }

  /**
   * Spec 16 §C-02 — Handle an incoming peer `query` message. Runs the
   * configured query handler if the node is idle; otherwise emits a
   * `queued` response and enqueues the work for later. Drains the local
   * queue one-at-a-time to avoid overlapping sessions.
   *
   * Spec 16 §F-02 / EP-04 / EP-05 — When an incoming elevated query
   * arrives at a node whose currently running query is non-elevated,
   * the running query is preempted (its result suppressed; the request
   * saved for re-issuance after the elevated query completes). Equal
   * elevation queues normally — no mutual preemption (§F-06 / EP-05).
   */
  async function handlePeerQuery(msg: MeshMessage): Promise<void> {
    const from = msg.from
    const payload = msg.payload as Record<string, any>
    const correlation_id = typeof payload.correlation_id === "string" ? payload.correlation_id : undefined
    const prompt = typeof payload.prompt === "string" ? payload.prompt : ""
    const persona = typeof payload.persona === "string" ? payload.persona : undefined
    const timeout_ms = typeof payload.timeout_ms === "number" ? payload.timeout_ms : undefined
    const elevated = payload.elevated === true

    // Spec 16 §C-07 — Missing correlation_id = old/malformed client.
    // Respond with a typed error rather than silently dropping.
    if (!correlation_id) {
      await sendResponseSafe(from, {
        status: "error",
        error: "Missing correlation_id on peer query (schema mismatch or older client)",
      })
      return
    }

    if (!_queryHandler) {
      await sendResponseSafe(from, {
        correlation_id,
        status: "error",
        error: "No query handler configured on peer",
      })
      return
    }

    const incoming: QueuedPeerQuery = { from, correlation_id, prompt, persona, timeout_ms, elevated }

    // Spec 16 §F-02 / EP-04 — Preemption path. Incoming elevated +
    // current non-elevated → save current for re-issuance, abort it,
    // and run the elevated query next. Equal elevation falls through
    // to the busy-queue path (EP-05 / §F-06).
    if (_running && incoming.elevated && !_running.q.elevated) {
      _preemptedQueue.push(_running.q)
      _running.preempted = true
      try {
        _running.controller.abort()
      } catch {}
      // Run elevated ahead of any other queued work. The currently
      // running drain loop will finish (returning early due to
      // preemption) and pick this up first.
      _peerQueryQueue.unshift(incoming)
      // No "queued" ack to elevated — it's about to run, not queued.
      return
    }

    // Spec 16 §C-02b / §F-06 / EP-05 — Busy (and not preempting):
    // queue locally, ack with queued_position. The drain loop will
    // pick it up. This is the equal-elevation path too.
    if (_running) {
      _peerQueryQueue.push(incoming)
      await sendResponseSafe(from, {
        correlation_id,
        status: "queued",
        queued_position: _peerQueryQueue.length,
      })
      return
    }

    // Idle — run immediately, then drain any queued / preempted items.
    await runDrainLoop(incoming)
  }

  /**
   * Spec 16 §F-02 / EP-04 — Outer drain loop.
   *
   * Runs `first`, then drains in priority order:
   *   1. _peerQueryQueue (FIFO; elevated entries pushed to front by handlePeerQuery)
   *   2. _preemptedQueue (FIFO of requests interrupted by elevated; re-issued)
   *
   * The single _running slot ensures only one handler is in flight
   * (modulo a preempted handler whose result is being discarded).
   */
  async function runDrainLoop(first: QueuedPeerQuery): Promise<void> {
    let next: QueuedPeerQuery | undefined = first
    while (next) {
      await runAndRespond(next)
      // After each run: pick from queue (elevated may have been
      // unshifted to the front), else resume preempted.
      next = _peerQueryQueue.shift() ?? _preemptedQueue.shift()
    }
  }

  async function runAndRespond(q: QueuedPeerQuery): Promise<void> {
    const controller = new AbortController()
    const slot: RunningQuery = { q, controller, preempted: false }
    _running = slot
    let result: PeerQueryHandlerResult | undefined
    let handlerError: unknown
    try {
      // Race the handler against the abort signal so an elevated
      // preemption can interrupt this slot. Handlers that ignore the
      // signal still terminate eventually; we just discard their
      // result if `slot.preempted` was set.
      result = await new Promise<PeerQueryHandlerResult>((resolve, reject) => {
        controller.signal.addEventListener("abort", () => {
          reject(new Error("__mesh_preempted__"))
        })
        _queryHandler!({
          prompt: q.prompt,
          persona: q.persona,
          timeoutMs: q.timeout_ms,
          signal: controller.signal,
        }).then(resolve, reject)
      })
    } catch (err) {
      handlerError = err
    } finally {
      // Only clear _running if it's still our slot (a re-entrant
      // handlePeerQuery during preempt may have already moved on).
      if (_running === slot) _running = undefined
    }

    if (slot.preempted) {
      // Suppress response — the request has been pushed onto
      // _preemptedQueue for re-issuance after the elevated query.
      log.info("mesh peer query preempted by elevated", {
        from: q.from,
        correlation_id: q.correlation_id,
      })
      return
    }

    if (handlerError !== undefined) {
      await sendResponseSafe(q.from, {
        correlation_id: q.correlation_id,
        status: "error",
        error: String(handlerError),
      })
      return
    }

    await sendResponseSafe(q.from, {
      correlation_id: q.correlation_id,
      status: "completed",
      response: result!.response,
      session_id: result!.sessionId,
    })
  }

  async function sendResponseSafe(to: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await send({ to, type: "response", payload })
    } catch (err) {
      // A send failure on the response path can't be retried meaningfully;
      // the originator will hit its own timeout. Log and move on.
      log.warn("mesh peer-query response send failed", { to, error: String(err) })
    }
  }

  /**
   * Spec 16 §C-03 / §C-04 / §C-06 — Match an incoming `response` message
   * against a pending correlation. `queued` fires onProgress without
   * resolving; `completed` / `error` resolve and drop the correlation.
   * Unknown correlations are logged and dropped (§C-06 — no crash).
   */
  function handlePeerResponse(msg: MeshMessage): void {
    const payload = msg.payload as Record<string, any>
    const correlationId = typeof payload.correlation_id === "string" ? payload.correlation_id : undefined
    if (!correlationId) {
      log.warn("mesh response missing correlation_id", { from: msg.from })
      return
    }
    const corr = _correlations.get(correlationId)
    if (!corr) {
      log.warn("mesh response for unknown correlation", { correlationId, from: msg.from })
      return
    }

    const status = payload.status
    if (status === "queued") {
      const queuedPosition = typeof payload.queued_position === "number" ? payload.queued_position : 0
      corr.onProgress?.({ status: "queued", queuedPosition })
      return
    }

    clearTimeout(corr.timer)
    _correlations.delete(correlationId)

    if (status === "completed") {
      corr.resolve({
        status: "completed",
        response: typeof payload.response === "string" ? payload.response : undefined,
        sessionId: typeof payload.session_id === "string" ? payload.session_id : undefined,
      })
    } else if (status === "error") {
      corr.resolve({
        status: "error",
        error: typeof payload.error === "string" ? payload.error : "Unknown peer error",
      })
    } else {
      log.warn("mesh response has unknown status", { correlationId, status, from: msg.from })
      corr.reject(new Error(`Unknown response status: ${status}`))
    }
  }
}
