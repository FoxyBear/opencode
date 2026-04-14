import { describe, expect, test } from "bun:test"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

describe("experimental workspace httpapi", () => {
  test("lists adaptors, workspaces, status, and serves docs", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default().app
    const headers = {
      "content-type": "application/json",
      "x-opencode-directory": tmp.path,
    }

    const adaptors = await app.request("/experimental/httpapi/workspace/adaptor", { headers })
    expect(adaptors.status).toBe(200)
    expect(Array.isArray(await adaptors.json())).toBe(true)

    const list = await app.request("/experimental/httpapi/workspace", { headers })
    expect(list.status).toBe(200)
    expect(Array.isArray(await list.json())).toBe(true)

    const status = await app.request("/experimental/httpapi/workspace/status", { headers })
    expect(status.status).toBe(200)
    expect(Array.isArray(await status.json())).toBe(true)

    const doc = await app.request("/experimental/httpapi/workspace/doc", { headers })
    expect(doc.status).toBe(200)
    const spec = await doc.json()
    expect(spec.paths["/experimental/httpapi/workspace/adaptor"]?.get?.operationId).toBe(
      "experimental.workspace.adaptor.list",
    )
    expect(spec.paths["/experimental/httpapi/workspace"]?.get?.operationId).toBe("experimental.workspace.list")
    expect(spec.paths["/experimental/httpapi/workspace/status"]?.get?.operationId).toBe("experimental.workspace.status")
  })
})
