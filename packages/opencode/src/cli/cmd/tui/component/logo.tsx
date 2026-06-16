import { TextAttributes } from "@opentui/core"
import { For } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { logo } from "@/cli/logo"

export function Logo() {
  const { theme } = useTheme()

  return (
    <box>
      <For each={logo.lines}>
        {(line) => (
          <box flexDirection="row">
            <text fg={theme.textMuted} selectable={false}>
              {line.slice(0, logo.splitAt)}
            </text>
            <text fg={theme.text} attributes={TextAttributes.BOLD} selectable={false}>
              {line.slice(logo.splitAt)}
            </text>
          </box>
        )}
      </For>
    </box>
  )
}
