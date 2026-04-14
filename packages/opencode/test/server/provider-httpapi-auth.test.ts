import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"
import { Log } from "../../src/util/log"

Log.init({ print: false })

describe("experimental provider httpapi", () => {
  test("lists provider auth methods and serves docs", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const pluginDir = path.join(dir, ".opencode", "plugin")
        await fs.mkdir(pluginDir, { recursive: true })
        await Bun.write(
          path.join(pluginDir, "custom-copilot-auth.ts"),
          [
            "export default {",
            '  id: "demo.custom-copilot-auth",',
            "  server: async () => ({",
            "    auth: {",
            '      provider: "github-copilot",',
            "      methods: [",
            '        { type: "api", label: "Test Override Auth" },',
            "      ],",
            "      loader: async () => ({ access: 'test-token' }),",
            "    },",
            "  }),",
            "}",
            "",
          ].join("\n"),
        )
      },
    })

    const app = Server.Default().app
    const headers = {
      "content-type": "application/json",
      "x-opencode-directory": tmp.path,
    }

    const list = await app.request("/experimental/httpapi/provider/auth", { headers })
    expect(list.status).toBe(200)
    const methods = await list.json()
    expect(methods["github-copilot"]).toBeDefined()
    expect(methods["github-copilot"][0].label).toBe("Test Override Auth")

    const doc = await app.request("/experimental/httpapi/provider/doc", { headers })
    expect(doc.status).toBe(200)
    const spec = await doc.json()
    expect(spec.paths["/experimental/httpapi/provider/auth"]?.get?.operationId).toBe("provider.auth")
  }, 30000)
})
