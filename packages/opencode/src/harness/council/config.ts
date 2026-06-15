import type { ModelInfo } from "./prompts"
import { readFileSync, existsSync } from "fs"
import { resolve } from "path"
import { homedir } from "os"

export const ALL_MODELS: ModelInfo[] = [
  { id: "gpt-5.4", name: "GPT-5.4", provider: "openai" },
  { id: "gpt-5.4-pro", name: "GPT-5.4 Pro", provider: "openai" },
  { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", provider: "openai" },
  { id: "gpt-5.4-nano", name: "GPT-5.4 Nano", provider: "openai" },
  { id: "o3", name: "o3", provider: "openai" },
  { id: "o4-mini", name: "o4-mini", provider: "openai" },
  { id: "gpt-4o", name: "GPT-4o", provider: "openai" },
  { id: "gpt-4o-mini", name: "GPT-4o Mini", provider: "openai" },
  { id: "claude-opus-4-8", name: "Claude Opus 4.8", provider: "anthropic" },
  { id: "claude-opus-4-7", name: "Claude Opus 4.7", provider: "anthropic" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", provider: "anthropic" },
  { id: "deepseek-ai/DeepSeek-V4-Pro", name: "DeepSeek V4 Pro", provider: "deepinfra" },
  { id: "deepseek-ai/DeepSeek-V4-Flash", name: "DeepSeek V4 Flash", provider: "deepinfra" },
  { id: "deepseek-ai/DeepSeek-V3.2", name: "DeepSeek V3.2", provider: "deepinfra" },
  { id: "deepseek-ai/DeepSeek-R1", name: "DeepSeek R1", provider: "deepinfra" },
  { id: "moonshotai/Kimi-K2.6", name: "Kimi K2.6", provider: "deepinfra" },
  { id: "moonshotai/Kimi-K2.5", name: "Kimi K2.5", provider: "deepinfra" },
  { id: "zai-org/GLM-5.1", name: "GLM-5.1", provider: "deepinfra" },
  { id: "Qwen/Qwen3.5-397B-A17B", name: "Qwen 3.5 397B", provider: "deepinfra" },
  { id: "mistralai/Mistral-Small-3.2-24B-Instruct-2506", name: "Mistral Small 3.2", provider: "deepinfra" },
]

export interface CouncilSettings {
  models: string[]
  arbitrator: string
  maxRounds: number
  threshold: number
  enableResearch: boolean
}

export function loadSettings(): CouncilSettings {
  const configPath = resolve(homedir(), ".config", "opencode", "council.json")
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8")
      return JSON.parse(raw) as CouncilSettings
    } catch {}
  }
  return {
    models: ["gpt-5.4", "claude-sonnet-4-6", "deepseek-ai/DeepSeek-V4-Pro", "moonshotai/Kimi-K2.6"],
    arbitrator: "gpt-5.4",
    maxRounds: 3,
    threshold: 4,
    enableResearch: false,
  }
}

export function resolveModel(id: string): ModelInfo {
  return ALL_MODELS.find((m) => m.id === id) ?? { id, name: id, provider: "openai" }
}
