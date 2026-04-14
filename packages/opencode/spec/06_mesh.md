# 06 — Mesh Network

## Objective

Define a private peer-to-peer mesh network between OpenCode instances using mDNS for discovery, the existing REST API for communication, and HMAC-signed message envelopes for security.

## Prior Art

- OpenCode `server/mdns.ts:6-60` — Existing mDNS via `bonjour-service`. Publishes `opencode-{port}` with `txt: { path: "/" }`.
- OpenCode `server/server.ts` + `server/instance.ts:46-60` — Hono routes with existing `/session`, `/config`, `/provider` endpoints
- OpenCode `@opencode-ai/sdk` — Client SDK for the REST API
- OpenCode ACP session management — Agent Client Protocol for remote session handling
- fbcli `spec/09_network.md` statements NW-01 through NW-07

## Behavior

### Node Registration

**WHEN** `opencode serve` starts with `mesh.enabled = true`,
the node **SHALL** publish an mDNS service with extended TXT records:

```
name: mesh.name (from config)
type: "http"
port: server port
txt: {
  path: "/",
  mesh: "1",
  persona: current default agent name,
  capabilities: comma-separated tool tag list,
  status: "idle"
}
```

**WHEN** `opencode serve` shuts down,
the node **SHALL** unpublish its mDNS service.

**WHEN** mDNS publishing fails (port conflict, name collision),
the node **SHALL** log a warning and operate without mesh (standalone mode).

### Peer Discovery

**WHEN** a node has mesh enabled,
it **SHALL** browse for other mDNS services of type `http` with `txt.mesh = "1"`.

**WHEN** a peer is discovered,
the node **SHALL** add it to the local peer registry with: name, address, port, persona, capabilities, status, last_seen.

**WHEN** a peer's mDNS service disappears,
the node **SHALL** mark it as `status: "offline"` in the peer registry after the mDNS goodbye.

**WHEN** a peer has not been seen for 5 consecutive heartbeat cycles (25 minutes),
the node **SHALL** remove it from the peer registry.

### Message Envelope

**WHEN** a node sends a message to a peer,
it **SHALL** construct an envelope:

```json
{
  "from": "sender-node-name",
  "to": "target-node-name",
  "type": "directive|status|query|response",
  "payload": {},
  "timestamp": "ISO-8601",
  "hmac": "hex-encoded HMAC-SHA256 of JSON(from+to+type+payload+timestamp)"
}
```

**WHEN** a node constructs an HMAC,
it **SHALL** use the shared secret from `mesh.secret` config (loaded via `{env:MESH_SECRET}`).

### Message Delivery

**WHEN** a node sends a message,
it **SHALL** POST the envelope to `http://{peer_address}:{peer_port}/mesh/message`.

**WHEN** the target peer is not in the registry,
the sender **SHALL** return an error: `"Node '{name}' is not online."`.

**WHEN** the POST request fails (connection refused, timeout > 5s),
the sender **SHALL** return an error: `"Failed to reach node '{name}'."`.

**WHEN** the target peer returns HTTP 401 (HMAC verification failed),
the sender **SHALL** return an error: `"Authentication failed with node '{name}'. Check mesh secret."`.

### Message Receiving

**WHEN** a node receives a POST to `/mesh/message`,
it **SHALL** verify the HMAC against the shared secret.

**WHEN** HMAC verification fails,
the node **SHALL** return HTTP 401 and log a security warning.

**WHEN** HMAC verification succeeds,
the node **SHALL** process the message by type:

- `directive`: Create a new session with the payload as the initial prompt, or inject into the current active session as a system message
- `status`: Log to mesh event log (not injected into sessions)
- `query`: Route to the active session or create one, inject as system message requiring a response
- `response`: Inject as system context into the session that sent the original query

### Task Delegation

**WHEN** a node delegates a task to a peer via `/mesh/delegate`,
it **SHALL** send a `directive` message with `payload: { prompt, persona, respond_to: sender_name }`.

**WHEN** a peer receives a delegation,
it **SHALL** create a session with the specified persona, run the prompt, and send the result back as a `response` message to `respond_to`.

### Heartbeat

**WHEN** mesh is enabled and the scheduler fires the heartbeat task (every 5 minutes),
the node **SHALL** update its mDNS TXT record with current `status` (idle/busy based on active sessions).

**WHEN** a node transitions between idle and busy,
it **SHALL** republish its mDNS service with the updated status.

## Interface Contract

```typescript
export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/Mesh") {}

export interface Interface {
  readonly start: () => Effect.Effect<void>
  readonly stop: () => Effect.Effect<void>
  readonly peers: () => Effect.Effect<Peer[]>
  readonly send: (input: {
    to: string
    type: MessageType
    payload: Record<string, unknown>
  }) => Effect.Effect<void>
  readonly delegate: (input: {
    to: string
    prompt: string
    persona?: string
  }) => Effect.Effect<SessionID>
  readonly onMessage: (handler: (msg: MeshMessage) => Effect.Effect<void>) => Effect.Effect<void>
}

export type MessageType = "directive" | "status" | "query" | "response"

export interface Peer {
  name: string
  address: string
  port: number
  persona: string
  capabilities: string[]
  status: "idle" | "busy" | "offline"
  last_seen: string
}

export interface MeshMessage {
  from: string
  to: string
  type: MessageType
  payload: Record<string, unknown>
  timestamp: string
  hmac: string
}

export interface MeshConfig {
  enabled: boolean
  name: string
  secret: string      // env reference
  mdns: boolean
}
```

## Server Routes

```typescript
// Added to server/instance.ts
.route("/mesh", MeshRoutes())

// Mesh routes
GET  /mesh/peers    → list discovered peers with capabilities
POST /mesh/message  → receive message envelope (HMAC verified)
POST /mesh/delegate → delegate task to this node
GET  /mesh/status   → this node's status, name, active sessions
```

## Harness Operations (automatic)

- mDNS publish/unpublish on serve start/stop
- Peer discovery via mDNS browse
- Incoming message injection into harness loop (via `loop.before`)
- Status updates (idle/busy) via mDNS TXT record republish

## LLM-Callable Tools

| Tool | Input | Returns |
|------|-------|---------|
| `mesh_send` | `{ to, type, payload }` | `"Sent to {name}"` or error |
| `mesh_peers` | `{}` | Formatted peer list |
| `mesh_delegate` | `{ to, prompt, persona? }` | `"Delegated to {name}, session {id}"` |

## Verification

```bash
bun test src/mesh/__tests__/mesh.test.ts

# mDNS publish
# Test: start with mesh.enabled → mDNS service published with TXT records

# Peer discovery
# Test: mock mDNS browse → peer appears in registry

# Message send + receive
# Test: 2 nodes → send directive A→B → B receives, HMAC valid

# HMAC rejection
# Test: send with wrong secret → 401 returned

# Offline peer
# Test: peer mDNS disappears → marked offline → removed after 25 min

# Task delegation
# Test: delegate to peer → peer creates session → result sent back

# Standalone mode
# Test: mDNS fails → mesh disabled, no errors
```

## Boundaries

- Mesh does NOT replace Summit's REST API (supplements it for direct peer communication)
- Mesh does NOT handle internet-facing communication (mDNS is local network only)
- Mesh does NOT persist messages (fire-and-forget with optional response)
- Mesh does NOT authenticate users (shared secret for node-to-node trust only)
- Mesh does NOT manage sessions (it creates them via the existing Session service)
