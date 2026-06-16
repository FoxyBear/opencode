import { PersonaSession } from "@/persona/session"
import { getConfig } from "@/config/bridge"
import { Log } from "@/util/log"

let _personaHookFired = false

export function _resetPersonaHook(): void {
  _personaHookFired = false
}

export async function hookPersonaDefault(_directory: string): Promise<void> {
  if (_personaHookFired) return
  _personaHookFired = true
  const name = process.env.OPENCODE_PERSONA
  if (!name || name.length === 0) return
  try {
    const cfg = await getConfig().catch(() => ({}) as any)
    const configuredMcpServers = Object.keys(cfg?.mcp ?? {})
    await PersonaSession.setDefault(name, configuredMcpServers)
  } catch (error) {
    Log.Default.warn("worker persona-default hook failed", {
      error: error instanceof Error ? error.message : error,
    })
  }
}
