import { describe, expect, test } from "bun:test"
import path from "path"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

describe("experimental file httpapi", () => {
  test("lists files, reads content, reports status, and serves docs", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "note.txt"), "hello")
      },
    })
    const app = Server.Default().app
    const headers = {
      "content-type": "application/json",
      "x-opencode-directory": tmp.path,
    }

    const list = await app.request("/experimental/httpapi/file?path=.", { headers })
    expect(list.status).toBe(200)
    const items = await list.json()
    expect(items.some((item: { name: string }) => item.name === "note.txt")).toBe(true)

    const read = await app.request("/experimental/httpapi/file/content?path=note.txt", { headers })
    expect(read.status).toBe(200)
    const content = await read.json()
    expect(content.type).toBe("text")
    expect(content.content).toContain("hello")

    const status = await app.request("/experimental/httpapi/file/status", { headers })
    expect(status.status).toBe(200)
    expect(Array.isArray(await status.json())).toBe(true)

    const doc = await app.request("/experimental/httpapi/file/doc", { headers })
    expect(doc.status).toBe(200)
    const spec = await doc.json()
    expect(spec.paths["/experimental/httpapi/file"]?.get?.operationId).toBe("file.list")
    expect(spec.paths["/experimental/httpapi/file/content"]?.get?.operationId).toBe("file.read")
    expect(spec.paths["/experimental/httpapi/file/status"]?.get?.operationId).toBe("file.status")
  })
})
