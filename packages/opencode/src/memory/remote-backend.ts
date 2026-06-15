import type { MemoryBackend, WriteInput, QueryInput, MemoryResult, BackendMetrics } from "./backend"

const TIMEOUT_MS = 10_000
const INIT_RETRY_DELAY_MS = 500
const INIT_MAX_ATTEMPTS = 2

export class RemoteMemoryBackend implements MemoryBackend {
  constructor(private readonly baseUrl: string) {}

  async init(): Promise<void> {
    for (let attempt = 1; attempt <= INIT_MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(`${this.baseUrl}/memory/metrics`, {
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
        if (res.ok) return
      } catch {}
      if (attempt < INIT_MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, INIT_RETRY_DELAY_MS))
      }
    }
    throw new Error(`RemoteMemoryBackend health check failed after ${INIT_MAX_ATTEMPTS} attempts at ${this.baseUrl}`)
  }

  async close(): Promise<void> {}

  async write(input: WriteInput): Promise<{ id: string }> {
    const body = {
      content: input.content,
      embedding: Array.from(input.embedding),
      scope: input.scope,
      persona: input.persona,
      project_id: input.project_id,
      source_session_id: input.source_session_id,
      supersedes_memory_id: input.supersedes_memory_id,
      metadata: input.metadata,
      created_at: input.created_at,
      id: input.id,
    }
    return this.post<{ id: string }>("/memory/write", body)
  }

  async query(input: QueryInput): Promise<MemoryResult[]> {
    const body = {
      query: input.query,
      queryEmbedding: Array.from(input.queryEmbedding),
      scope: input.scope,
      persona: input.persona,
      project_id: input.project_id,
      as_of: input.as_of,
      limit: input.limit,
    }
    return this.post<MemoryResult[]>("/memory/query", body)
  }

  async forget(id: string): Promise<void> {
    await this.post("/memory/forget", { id })
  }

  async list(persona: string, limit?: number): Promise<MemoryResult[]> {
    return this.post<MemoryResult[]>("/memory/list", { persona, limit })
  }

  async getPrunable(ttl_days: number): Promise<MemoryResult[]> {
    return this.post<MemoryResult[]>("/memory/prunable", { ttl_days })
  }

  async metrics(): Promise<BackendMetrics> {
    const res = await fetch(`${this.baseUrl}/memory/metrics`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
      throw new Error(`RemoteMemoryBackend GET /memory/metrics failed: ${res.status}`)
    }
    return res.json()
  }

  private async post<T>(endpoint: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
      throw new Error(`RemoteMemoryBackend POST ${endpoint} failed: ${res.status}`)
    }
    return res.json()
  }
}
