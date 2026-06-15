import { Config } from "./config"
import { AppRuntime } from "@/effect/app-runtime"

export async function getConfig(): Promise<Config.Info> {
  return AppRuntime.runPromise(Config.Service.use((svc) => svc.get()))
}

export async function getGlobalConfig(): Promise<Config.Info> {
  return AppRuntime.runPromise(Config.Service.use((svc) => svc.getGlobal()))
}
