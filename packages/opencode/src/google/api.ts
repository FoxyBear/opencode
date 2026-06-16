import { GoogleAuth } from "./auth"

async function fetchWithAuthRetry(
  url: string,
  opts: RequestInit | undefined,
  extraHeaders: Record<string, string>,
): Promise<Response> {
  const token = await GoogleAuth.getAccessToken()
  if (!token) throw new Error(GoogleAuth.authErrorMessage())

  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      ...extraHeaders,
      ...opts?.headers,
    },
  })

  if (res.status === 401 || res.status === 403) {
    GoogleAuth._reset()
    const freshToken = await GoogleAuth.getAccessToken()
    if (freshToken && freshToken !== token) {
      return fetch(url, {
        ...opts,
        headers: {
          Authorization: `Bearer ${freshToken}`,
          ...extraHeaders,
          ...opts?.headers,
        },
      })
    }
  }

  return res
}

export async function googleFetch(url: string, opts?: RequestInit): Promise<any> {
  const res = await fetchWithAuthRetry(url, opts, { "Content-Type": "application/json" })

  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`Google API error ${res.status}: ${body.slice(0, 500)}`)
  }

  return res.json()
}

export async function googleFetchText(url: string, opts?: RequestInit): Promise<string> {
  const res = await fetchWithAuthRetry(url, opts, {})

  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`Google API error ${res.status}: ${body.slice(0, 500)}`)
  }

  return res.text()
}
