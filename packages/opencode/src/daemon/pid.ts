export interface DaemonStatus {
  state: "running" | "stopped" | "stale"
  pid?: number
  port?: number
}

export namespace DaemonPid {
  export function check(_pidFile?: string): DaemonStatus {
    return { state: "stopped" }
  }

  export function write(_port: number, _pidFile?: string): void {}

  export function remove(_pidFile?: string): void {}
}
