import z from "zod"
import { Effect } from "effect"
import { Tool } from "../tool/tool"
import { googleFetch, googleFetchText } from "./api"

const BASE = "https://www.googleapis.com/drive/v3"

export const DriveSearchTool = Tool.define(
  "drive_search",
  Effect.succeed({
    description: "Search Google Drive for files. Returns file metadata.",
    parameters: z.object({
      query: z.string().describe("Drive search query (e.g., 'name contains \"report\"')"),
      max_results: z.number().optional().default(10).describe("Maximum results"),
    }),
    execute: (params: { query: string; max_results: number }, _ctx: Tool.Context) =>
      Effect.promise(async () => {
        const data = await googleFetch(
          `${BASE}/files?q=${encodeURIComponent(params.query)}&pageSize=${params.max_results}&fields=files(id,name,mimeType,modifiedTime,size)`,
        )

        if (!data.files?.length) return { title: "No files found", output: "No files match the query.", metadata: { count: 0 } }

        const lines = data.files.map((f: any) =>
          `- **${f.name}** (${f.mimeType}) | Modified: ${f.modifiedTime ?? "?"}${f.size ? ` | ${Math.round(f.size / 1024)}KB` : ""}\n  ID: ${f.id}`,
        )

        return { title: `${data.files.length} files`, output: lines.join("\n"), metadata: { count: data.files.length } }
      }),
  }),
)

export const DriveReadTool = Tool.define(
  "drive_read",
  Effect.succeed({
    description: "Read a Google Drive file. Returns text content for docs/sheets, metadata for binary files.",
    parameters: z.object({
      file_id: z.string().describe("The Drive file ID"),
    }),
    execute: (params: { file_id: string }, _ctx: Tool.Context) =>
      Effect.promise(async () => {
        const meta = await googleFetch(`${BASE}/files/${params.file_id}?fields=id,name,mimeType,size`)

        if (meta.mimeType?.startsWith("application/vnd.google-apps.")) {
          // Google Docs/Sheets/etc — export as plain text
          const exportMime = meta.mimeType.includes("spreadsheet") ? "text/csv" : "text/plain"
          const content = await googleFetchText(
            `${BASE}/files/${params.file_id}/export?mimeType=${encodeURIComponent(exportMime)}`,
          )
          return { title: meta.name, output: content.slice(0, 10000), metadata: { file_id: params.file_id, mimeType: meta.mimeType } }
        }

        if (meta.mimeType?.startsWith("text/")) {
          const content = await googleFetchText(`${BASE}/files/${params.file_id}?alt=media`)
          return { title: meta.name, output: content.slice(0, 10000), metadata: { file_id: params.file_id, mimeType: meta.mimeType } }
        }

        return {
          title: meta.name,
          output: `Binary file: ${meta.name} (${meta.mimeType}, ${meta.size ? Math.round(meta.size / 1024) + "KB" : "unknown size"})`,
          metadata: { file_id: params.file_id, mimeType: meta.mimeType },
        }
      }),
  }),
)

export const DriveListTool = Tool.define(
  "drive_list",
  Effect.succeed({
    description: "List files in a Google Drive folder.",
    parameters: z.object({
      folder_id: z.string().optional().default("root").describe("Folder ID (default: root)"),
      max_results: z.number().optional().default(20).describe("Maximum results"),
    }),
    execute: (params: { folder_id: string; max_results: number }, _ctx: Tool.Context) =>
      Effect.promise(async () => {
        const q = `'${params.folder_id}' in parents and trashed=false`
        const data = await googleFetch(
          `${BASE}/files?q=${encodeURIComponent(q)}&pageSize=${params.max_results}&fields=files(id,name,mimeType,modifiedTime,size)&orderBy=folder,name`,
        )

        if (!data.files?.length) return { title: "Empty folder", output: "No files in this folder.", metadata: { count: 0 } }

        const lines = data.files.map((f: any) => {
          const isFolder = f.mimeType === "application/vnd.google-apps.folder"
          return `- ${isFolder ? "[folder] " : ""}**${f.name}** (${f.mimeType}) | ${f.modifiedTime ?? ""}\n  ID: ${f.id}`
        })

        return { title: `${data.files.length} items`, output: lines.join("\n"), metadata: { count: data.files.length } }
      }),
  }),
)
