import { getConfig } from "../config/bridge"
import { Log } from "../util/log"

const log = Log.create({ service: "trello.auth" })

export interface TrelloCredentials {
  api_key: string
  api_token: string
}

let _cached: TrelloCredentials | null = null

export namespace TrelloAuth {
  export async function getCredentials(): Promise<TrelloCredentials | null> {
    if (_cached) return _cached

    try {
      const cfg = await getConfig()
      const t = cfg.atlassian
      if (!t?.api_key || !t?.api_token) {
        log.info("trello not configured in foxybear.json")
        return null
      }

      _cached = { api_key: t.api_key, api_token: t.api_token }
      return _cached
    } catch (err) {
      log.info("trello auth not configured", { error: String(err) })
      return null
    }
  }

  export function authParams(creds: TrelloCredentials): string {
    return `key=${creds.api_key}&token=${creds.api_token}`
  }

  export function authErrorMessage(): string {
    return `Trello authentication required. Add "atlassian": { "api_key": "{file:path/to/key}", "api_token": "{file:path/to/token}" } to your foxybear.json config. Get your API key at https://trello.com/power-ups/admin and generate a token from the key page.`
  }

  export function _reset(): void {
    _cached = null
  }
}
