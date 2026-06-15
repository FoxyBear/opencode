import z from "zod"
import { Effect } from "effect"
import { Tool } from "../tool/tool"
import { telegramApi, sendMessage as tgSend } from "./api"
import { TelegramBot } from "./bot"

export const TelegramSendTool = Tool.define(
  "telegram_send",
  Effect.succeed({
    description: "Send a text message to a Telegram chat.",
    parameters: z.object({
      chat_id: z.string().describe("The Telegram chat ID to send to"),
      text: z.string().describe("The message text to send"),
    }),
    execute: (params: { chat_id: string; text: string }, _ctx: Tool.Context) =>
      Effect.promise(async () => {
        const config = TelegramBot.getConfig()
        if (!config.bot_token) {
          return { title: "Not configured", output: "Telegram bot token not configured.", metadata: {} }
        }

        await tgSend(config.bot_token, params.chat_id, params.text)
        return {
          title: "Message sent",
          output: `Sent message to chat ${params.chat_id}`,
          metadata: { chat_id: params.chat_id },
        }
      }),
  }),
)

export const TelegramReadTool = Tool.define(
  "telegram_read",
  Effect.succeed({
    description: "Read recent messages from Telegram updates (bot must be running).",
    parameters: z.object({
      limit: z.number().optional().default(10).describe("Maximum messages to return"),
    }),
    execute: (params: { limit: number }, _ctx: Tool.Context) =>
      Effect.promise(async () => {
        const config = TelegramBot.getConfig()
        if (!config.bot_token) {
          return { title: "Not configured", output: "Telegram bot token not configured.", metadata: {} }
        }

        // Get recent updates without long polling (timeout=0)
        const updates = await telegramApi(config.bot_token, "getUpdates", { timeout: 0, limit: params.limit })
        if (!updates?.length) {
          return { title: "No messages", output: "No recent messages.", metadata: { count: 0 } }
        }

        const messages = updates
          .filter((u: any) => u.message?.text)
          .map((u: any) => {
            const m = u.message
            const from = m.from?.first_name ?? m.from?.username ?? "unknown"
            return `- [${new Date(m.date * 1000).toISOString()}] ${from}: ${m.text}`
          })

        return {
          title: `${messages.length} messages`,
          output: messages.join("\n"),
          metadata: { count: messages.length },
        }
      }),
  }),
)
