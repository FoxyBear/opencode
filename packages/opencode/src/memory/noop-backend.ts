import type { MemoryBackend, WriteInput, QueryInput, BackendMetrics } from "./backend"

export class NoOpMemoryBackend implements MemoryBackend {
  constructor(private readonly reason: string) {}

  async init(): Promise<void> {}
  async close(): Promise<void> {}

  async write(_input: WriteInput): Promise<never> {
    throw new Error(`memory backend unavailable: ${this.reason}`)
  }

  async query(_input: QueryInput): Promise<never> {
    throw new Error(`memory backend unavailable: ${this.reason}`)
  }

  async forget(_id: string): Promise<never> {
    throw new Error(`memory backend unavailable: ${this.reason}`)
  }

  async list(_persona: string, _limit?: number): Promise<never> {
    throw new Error(`memory backend unavailable: ${this.reason}`)
  }

  async getPrunable(_ttl_days: number): Promise<never> {
    throw new Error(`memory backend unavailable: ${this.reason}`)
  }

  async metrics(): Promise<BackendMetrics> {
    return { instance_count: 0, project_count: 0, global_count: 0, edge_count: 0 }
  }
}
