import { TrelloAuth } from "./auth"

const BASE = "https://api.trello.com/1"

export async function trelloFetch(path: string, opts?: RequestInit): Promise<any> {
  const creds = await TrelloAuth.getCredentials()
  if (!creds) throw new Error(TrelloAuth.authErrorMessage())

  const sep = path.includes("?") ? "&" : "?"
  const url = `${BASE}${path}${sep}${TrelloAuth.authParams(creds)}`

  const res = await fetch(url, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...opts?.headers,
    },
  })

  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`Trello API error ${res.status}: ${body.slice(0, 500)}`)
  }

  return res.json()
}
