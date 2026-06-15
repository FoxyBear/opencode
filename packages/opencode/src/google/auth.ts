import { OAuth2Client } from "google-auth-library"
import fs from "fs/promises"
import path from "path"
import { Global } from "../global"
import { Log } from "../util/log"

const log = Log.create({ service: "google.auth" })

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/contacts",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/chat.spaces.readonly",
  "https://www.googleapis.com/auth/chat.messages",
]

const CONFIG_DIR = "google-workspace"
const TOKEN_FILE = "token.json"
const CREDENTIALS_FILE = "credentials.json"

function getConfigDir(): string {
  return path.join(Global.Path.config, CONFIG_DIR)
}

function getTokenPath(): string {
  return path.join(getConfigDir(), TOKEN_FILE)
}

function getCredentialsPath(): string {
  return path.join(getConfigDir(), CREDENTIALS_FILE)
}

interface TokenData {
  access_token: string
  refresh_token?: string
  token_type: string
  expiry_date?: number
  scope?: string
}

let _cachedClient: OAuth2Client | null = null

export namespace GoogleAuth {
  /**
   * Get an authenticated OAuth2 client. Loads credentials and token from disk.
   * Returns null if not authenticated.
   */
  export async function getClient(): Promise<OAuth2Client | null> {
    if (_cachedClient) {
      // Check if token needs refresh
      const creds = _cachedClient.credentials
      if (creds.expiry_date != null && creds.expiry_date < Date.now() + 60_000) {
        try {
          const { credentials } = await _cachedClient.refreshAccessToken()
          _cachedClient.setCredentials(credentials)
          await saveToken(credentials as TokenData)
        } catch (err) {
          log.warn("token refresh failed", { error: String(err) })
          _cachedClient = null
          return null
        }
      }
      return _cachedClient
    }

    try {
      const credentialsRaw = await fs.readFile(getCredentialsPath(), "utf-8")
      const credentials = JSON.parse(credentialsRaw)
      const { client_id, client_secret, redirect_uris } = credentials.installed ?? credentials.web ?? {}

      if (!client_id || !client_secret) {
        log.warn("google credentials missing client_id or client_secret")
        return null
      }

      const client = new OAuth2Client(client_id, client_secret, redirect_uris?.[0] ?? "http://localhost:3000/callback")

      // Load saved token
      const tokenRaw = await fs.readFile(getTokenPath(), "utf-8")
      const token = JSON.parse(tokenRaw) as TokenData
      client.setCredentials(token)

      // Refresh if expired
      if (token.expiry_date != null && token.expiry_date < Date.now() + 60_000) {
        const { credentials: refreshed } = await client.refreshAccessToken()
        client.setCredentials(refreshed)
        await saveToken(refreshed as TokenData)
      }

      _cachedClient = client
      return client
    } catch (err) {
      log.info("google auth not configured", { error: String(err) })
      return null
    }
  }

  /**
   * Get an access token string for direct API calls.
   * Returns null if not authenticated.
   */
  export async function getAccessToken(): Promise<string | null> {
    const client = await getClient()
    if (!client) return null
    const token = client.credentials.access_token
    return token ?? null
  }

  /**
   * Check if Google auth is configured and valid.
   */
  export async function isAuthenticated(): Promise<boolean> {
    const client = await getClient()
    return client !== null && !!client.credentials.access_token
  }

  /**
   * Get the auth error message for tool responses when not authenticated.
   */
  export function authErrorMessage(): string {
    return `Google authentication required. Place your OAuth credentials.json at ${getCredentialsPath()} and token.json at ${getTokenPath()}. See Google Cloud Console to create OAuth 2.0 credentials.`
  }

  /**
   * Get the scopes this integration requests.
   */
  export function getScopes(): string[] {
    return [...SCOPES]
  }

  async function saveToken(token: TokenData): Promise<void> {
    await fs.mkdir(getConfigDir(), { recursive: true })
    await fs.writeFile(getTokenPath(), JSON.stringify(token, null, 2))
    log.info("google token saved")
  }

  export function _reset(): void {
    _cachedClient = null
  }
}
