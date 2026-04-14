import { describe, expect, test } from "bun:test"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

describe("experimental config providers httpapi", () => {
  test("lists config providers and serves docs", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default().app
    const headers = {
      "content-type": "application/json",
      "x-opencode-directory": tmp.path,
    }

    const res = await app.request("/experimental/httpapi/config/providers", { headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.providers)).toBe(true)
    expect(typeof body.default).toBe("object")

    const doc = await app.request("/experimental/httpapi/config/doc", { headers })
    expect(doc.status).toBe(200)
    const spec = await doc.json()
    expect(spec.paths["/experimental/httpapi/config/providers"]?.get?.operationId).toBe("config.providers")
  })
})
