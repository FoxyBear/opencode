import { Server } from "../../server/server"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions, type NetworkOptions } from "../network"
import { Flag } from "../../flag/flag"
import { DaemonLifecycle } from "../../daemon/lifecycle"
import { DaemonPid } from "../../daemon/pid"
import { DaemonRoutes } from "../../daemon/routes"
import { Runner } from "../../daemon/runner"
import { Scheduler } from "../../scheduler/scheduler"
import { Mesh } from "../../mesh/mesh"
import { createGraphBackend, setGlobalGraphBackend } from "../../memory/graph"
import { createMemoryBackend, setGlobalMemoryBackend } from "../../memory/backend-registry"
import { getGlobalConfig } from "../../config/bridge"
import { Global } from "../../global"
import { spawn } from "child_process"
import { openSync, existsSync } from "fs"
import path from "path"

async function startDaemon(args: NetworkOptions & { background?: boolean }) {
  if (!Flag.OPENCODE_SERVER_PASSWORD) {
    console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
  }

  const networkOpts = await resolveNetworkOptions(args)

  DaemonPid.acquire()
  process.on("exit", () => DaemonPid.remove())

  const config = await getGlobalConfig()

  const surrealConfig = config?.memory?.surreal
  const graphBackendType = config?.memory?.graph_backend ?? "sqlite"
  if (graphBackendType === "surreal") {
    const url = surrealConfig?.url ?? "ws://127.0.0.1:8000"
    const httpUrl = url.replace(/^ws/, "http").replace(/\/$/, "") + "/health"
    try {
      const res = await fetch(httpUrl, { signal: AbortSignal.timeout(3000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch {
      console.error(`Error: SurrealDB server is not reachable at ${url}`)
      console.error(`Start it with:\n  ~/.surrealdb/surreal start --user root --pass root surrealkv:~/.local/share/opencode/memory-server`)
      process.exit(1)
    }
  }

  let listener: Server.Listener | undefined

  await DaemonLifecycle.start({
    subsystems: [
      {
        name: "database",
        fatal: true,
        async init() {},
        async stop() {},
      },
      {
        name: "graph",
        fatal: true,
        async init() {
          const backendType = (config?.memory?.graph_backend ?? "sqlite") as "sqlite" | "neo4j" | "surreal"
          const backend = createGraphBackend(backendType, { surreal: surrealConfig })
          await backend.init()
          setGlobalGraphBackend(backend)
        },
        async stop() {
          const { getGlobalGraphBackend } = await import("../../memory/graph")
          const backend = getGlobalGraphBackend()
          if (backend) {
            await backend.close()
            setGlobalGraphBackend(null)
          }
        },
      },
      {
        name: "memory-backend",
        fatal: true,
        async init() {
          const backendType = (config?.memory?.graph_backend ?? "sqlite") as "sqlite" | "surreal"
          const { getGlobalGraphBackend } = await import("../../memory/graph")
          const graphBackend = getGlobalGraphBackend()
          const sharedDb = backendType === "surreal" && (graphBackend as any)?.getDb?.()
            ? (graphBackend as any).getDb()
            : undefined
          const backend = await createMemoryBackend(backendType, { db: sharedDb, surreal: surrealConfig })
          if (backend) {
            await backend.init()
            setGlobalMemoryBackend(backend)
          }
        },
        async stop() {
          const { getGlobalMemoryBackend } = await import("../../memory/backend-registry")
          const backend = getGlobalMemoryBackend()
          if (backend) {
            await backend.close()
            setGlobalMemoryBackend(null)
          }
        },
      },
      {
        name: "mesh",
        fatal: false,
        async init() {
          if (config?.mesh?.enabled) {
            await Mesh.start({
              enabled: true,
              name: config.mesh.name || "",
              secret: config.mesh.secret || "",
              mdns: config.mesh.mdns ?? true,
              port: networkOpts.port || 10274,
              elevated: config.owner?.elevated === true,
            })
            Mesh.setQueryHandler(async (input) => {
              const { HeadlessSession } = await import("../../daemon/headless")
              return HeadlessSession.run(input)
            })
          }
        },
        async stop() {
          Mesh.setQueryHandler(undefined)
          await Mesh.stop()
        },
      },
      {
        name: "scheduler",
        fatal: false,
        async init() {
          if (config?.scheduler?.enabled) {
            await Scheduler.start(config.scheduler, {
              mesh: config.mesh ? { enabled: config.mesh.enabled } : undefined,
            })
          }
        },
        async stop() {
          await Scheduler.stop()
        },
      },
      {
        name: "telegram",
        fatal: false,
        async init() {
          if (config?.telegram?.enabled) {
            const { TelegramBot } = await import("../../telegram/bot")
            await TelegramBot.start(config.telegram)
          }
        },
        async stop() {
          const { TelegramBot } = await import("../../telegram/bot")
          await TelegramBot.stop()
        },
      },
      {
        name: "http",
        fatal: true,
        async init() {
          Runner.wire({})
          listener = await Server.listen({ ...networkOpts, extraRoutes: DaemonRoutes() })
        },
        async stop() {
          if (listener) await listener.stop(true)
        },
      },
    ],
  })

  DaemonPid.updatePort(listener!.port)

  console.log(`foxybear daemon listening on http://${listener!.hostname}:${listener!.port}`)

  await new Promise(() => {})
}

export const ServeCommand = cmd({
  command: "serve [action]",
  describe: "manage the foxybear daemon",
  builder: (yargs) =>
    withNetworkOptions(yargs)
      .positional("action", {
        type: "string" as const,
        describe: "start | stop | status | logs",
        choices: ["start", "stop", "status", "logs"] as const,
      })
      .option("background", {
        type: "boolean" as const,
        alias: "b",
        describe: "run daemon in background",
        default: false,
      }),
  handler: async (args) => {
    const action = args.action as string | undefined

    if (!action) {
      if (args.background) {
        return daemonize()
      }
      return startDaemon(args)
    }

    switch (action) {
      case "start":
        return daemonize()
      case "stop":
        return stopDaemon()
      case "status":
        return showStatus(args)
      case "logs":
        return tailLogs()
    }
  },
})

function daemonize(): void {
  const argv = [process.argv[0]!, "serve"]
  for (const arg of process.argv.slice(2)) {
    if (arg === "start" || arg === "--background" || arg === "-b") continue
    if (arg === "serve") continue
    argv.push(arg)
  }

  const logFile = path.join(Global.Path.log, "serve.log")
  const out = openSync(logFile, "a")
  const err = openSync(logFile, "a")

  const child = spawn(process.execPath, argv.slice(1), {
    detached: true,
    stdio: ["ignore", out, err],
    env: { ...process.env },
  })
  child.unref()

  console.log(`foxybear daemon started in background (PID ${child.pid})`)
  console.log(`Log file: ${logFile}`)
  process.exit(0)
}

function stopDaemon(): void {
  const pidStatus = DaemonPid.check()

  if (pidStatus.state === "stopped") {
    console.log("No daemon running (no PID file found)")
    process.exit(1)
  }

  try {
    process.kill(pidStatus.pid!, "SIGTERM")
    console.log(`Sent SIGTERM to daemon (PID ${pidStatus.pid})`)
  } catch (err) {
    console.error(`Failed to stop daemon: ${err}`)
    process.exit(1)
  }
}

async function showStatus(args: NetworkOptions): Promise<void> {
  const pidStatus = DaemonPid.check()

  if (pidStatus.state === "stopped") {
    console.log("Daemon is not running")
    process.exit(1)
  }

  const networkOpts = await resolveNetworkOptions(args)
  const port = pidStatus.port || networkOpts.port || 10274
  const hostname = networkOpts.hostname || "127.0.0.1"
  const url = `http://${hostname}:${port}/health`

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) {
      console.log(`Daemon running (PID ${pidStatus.pid}) but health check failed: HTTP ${res.status}`)
      process.exit(1)
    }
    const health = await res.json()
    console.log(JSON.stringify(health, null, 2))
  } catch {
    console.log(`Daemon running (PID ${pidStatus.pid}) but health endpoint unreachable at ${url}`)
    process.exit(1)
  }
}

function tailLogs(): void {
  const logFile = path.join(Global.Path.log, "serve.log")

  if (!existsSync(logFile)) {
    console.log(`No log file found at ${logFile}`)
    process.exit(1)
  }

  const tail = spawn("tail", ["-f", logFile], { stdio: "inherit" })
  tail.on("exit", (code: number) => process.exit(code ?? 0))
}
