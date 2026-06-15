import z from "zod"
import { Effect } from "effect"
import { Tool } from "../tool/tool"
import { googleFetch } from "./api"

const BASE = "https://sheets.googleapis.com/v4/spreadsheets"

export const SheetsReadTool = Tool.define(
  "sheets_read",
  Effect.succeed({
    description: "Read cell values from a Google Sheet in A1 notation range.",
    parameters: z.object({
      spreadsheet_id: z.string().describe("The spreadsheet ID"),
      range: z.string().describe("A1 notation range (e.g., 'Sheet1!A1:D10')"),
    }),
    execute: (params: { spreadsheet_id: string; range: string }, _ctx: Tool.Context) =>
      Effect.promise(async () => {
        const data = await googleFetch(
          `${BASE}/${params.spreadsheet_id}/values/${encodeURIComponent(params.range)}`,
        )

        if (!data.values?.length) return { title: "Empty range", output: "No data in this range.", metadata: { rows: 0 } }

        const rows = data.values.map((row: any[], i: number) => `${i + 1}. ${row.join(" | ")}`)
        return { title: `${data.values.length} rows`, output: rows.join("\n"), metadata: { rows: data.values.length } }
      }),
  }),
)

export const SheetsWriteTool = Tool.define(
  "sheets_write",
  Effect.succeed({
    description: "Write values to a Google Sheet range.",
    parameters: z.object({
      spreadsheet_id: z.string().describe("The spreadsheet ID"),
      range: z.string().describe("A1 notation range (e.g., 'Sheet1!A1:D3')"),
      values: z.array(z.array(z.string())).describe("2D array of cell values (rows x columns)"),
    }),
    execute: (params: { spreadsheet_id: string; range: string; values: string[][] }, _ctx: Tool.Context) =>
      Effect.promise(async () => {
        const data = await googleFetch(
          `${BASE}/${params.spreadsheet_id}/values/${encodeURIComponent(params.range)}?valueInputOption=USER_ENTERED`,
          {
            method: "PUT",
            body: JSON.stringify({ values: params.values }),
          },
        )

        return {
          title: "Cells updated",
          output: `Updated ${data.updatedCells ?? "?"} cells in ${params.range}`,
          metadata: { updated_cells: data.updatedCells },
        }
      }),
  }),
)

export const SheetsAppendTool = Tool.define(
  "sheets_append",
  Effect.succeed({
    description: "Append rows after the last row with data in a Google Sheet range.",
    parameters: z.object({
      spreadsheet_id: z.string().describe("The spreadsheet ID"),
      range: z.string().describe("A1 notation range to append to (e.g., 'Sheet1!A:D')"),
      values: z.array(z.array(z.string())).describe("2D array of row values to append"),
    }),
    execute: (params: { spreadsheet_id: string; range: string; values: string[][] }, _ctx: Tool.Context) =>
      Effect.promise(async () => {
        const data = await googleFetch(
          `${BASE}/${params.spreadsheet_id}/values/${encodeURIComponent(params.range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
          {
            method: "POST",
            body: JSON.stringify({ values: params.values }),
          },
        )

        const updated = data.updates?.updatedCells ?? "?"
        return { title: "Rows appended", output: `Appended ${params.values.length} rows (${updated} cells)`, metadata: { rows_appended: params.values.length } }
      }),
  }),
)

export const SheetsListTool = Tool.define(
  "sheets_list",
  Effect.succeed({
    description: "List all sheet names and dimensions in a Google Spreadsheet.",
    parameters: z.object({
      spreadsheet_id: z.string().describe("The spreadsheet ID"),
    }),
    execute: (params: { spreadsheet_id: string }, _ctx: Tool.Context) =>
      Effect.promise(async () => {
        const data = await googleFetch(`${BASE}/${params.spreadsheet_id}?fields=sheets(properties)`)

        if (!data.sheets?.length) return { title: "No sheets", output: "Spreadsheet has no sheets.", metadata: { count: 0 } }

        const lines = data.sheets.map((s: any) => {
          const p = s.properties
          return `- **${p.title}** (${p.gridProperties?.rowCount ?? "?"} rows x ${p.gridProperties?.columnCount ?? "?"} cols) | ID: ${p.sheetId}`
        })

        return { title: `${data.sheets.length} sheets`, output: lines.join("\n"), metadata: { count: data.sheets.length } }
      }),
  }),
)
