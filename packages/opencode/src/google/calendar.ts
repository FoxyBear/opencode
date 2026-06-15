import z from "zod"
import { Effect } from "effect"
import { Tool } from "../tool/tool"
import { googleFetch } from "./api"

const BASE = "https://www.googleapis.com/calendar/v3"

const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone

export const CalendarReadTool = Tool.define(
  "calendar_read",
  Effect.succeed({
    description: "Read calendar events in a date range. Defaults to next 7 days.",
    parameters: z.object({
      start: z.string().optional().describe("Start date/time (ISO 8601, default: now)"),
      end: z.string().optional().describe("End date/time (ISO 8601, default: 7 days from now)"),
      calendar_id: z.string().optional().default("primary").describe("Calendar ID (default: primary)"),
    }),
    execute: (params: { start?: string; end?: string; calendar_id: string }, _ctx: Tool.Context) =>
      Effect.promise(async () => {
        const now = new Date()
        const start = params.start ?? now.toISOString()
        const end = params.end ?? new Date(now.getTime() + 7 * 86400000).toISOString()

        const ensureTZ = (dt: string) => /[Z+\-]\d/.test(dt) ? dt : new Date(dt).toISOString()

        const data = await googleFetch(
          `${BASE}/calendars/${encodeURIComponent(params.calendar_id)}/events?timeMin=${encodeURIComponent(ensureTZ(start))}&timeMax=${encodeURIComponent(ensureTZ(end))}&timeZone=${encodeURIComponent(LOCAL_TZ)}&singleEvents=true&orderBy=startTime&maxResults=50`,
        )

        if (!data.items?.length) return { title: "No events", output: "No events in this range.", metadata: { count: 0 } }

        const lines = data.items.map((e: any) => {
          const startStr = e.start?.dateTime ?? e.start?.date ?? "?"
          const endStr = e.end?.dateTime ?? e.end?.date ?? "?"
          const attendees = e.attendees?.map((a: any) => a.email).join(", ") ?? ""
          return `- **${e.summary ?? "(no title)"}** | ${startStr} → ${endStr}${e.location ? ` | ${e.location}` : ""}${attendees ? ` | Attendees: ${attendees}` : ""}\n  ID: ${e.id}`
        })

        return { title: `${data.items.length} events`, output: lines.join("\n"), metadata: { count: data.items.length } }
      }),
  }),
)

export const CalendarWriteTool = Tool.define(
  "calendar_write",
  Effect.succeed({
    description: "Create a calendar event. Returns the event ID.",
    parameters: z.object({
      title: z.string().describe("Event title"),
      start: z.string().describe("Start date/time (ISO 8601)"),
      end: z.string().describe("End date/time (ISO 8601)"),
      description: z.string().optional().describe("Event description"),
      attendees: z.array(z.string()).optional().describe("Attendee email addresses"),
      location: z.string().optional().describe("Event location"),
      calendar_id: z.string().optional().default("primary"),
    }),
    execute: (params: { title: string; start: string; end: string; description?: string; attendees?: string[]; location?: string; calendar_id: string }, _ctx: Tool.Context) =>
      Effect.promise(async () => {
        const event: any = {
          summary: params.title,
          start: { dateTime: params.start, timeZone: LOCAL_TZ },
          end: { dateTime: params.end, timeZone: LOCAL_TZ },
        }
        if (params.description) event.description = params.description
        if (params.attendees) event.attendees = params.attendees.map((email) => ({ email }))
        if (params.location) event.location = params.location

        const data = await googleFetch(`${BASE}/calendars/${encodeURIComponent(params.calendar_id)}/events`, {
          method: "POST",
          body: JSON.stringify(event),
        })

        return { title: "Event created", output: `Event "${params.title}" created. ID: ${data.id}`, metadata: { event_id: data.id } }
      }),
  }),
)

export const CalendarUpdateTool = Tool.define(
  "calendar_update",
  Effect.succeed({
    description: "Update fields on an existing calendar event.",
    parameters: z.object({
      event_id: z.string().describe("The event ID to update"),
      title: z.string().optional().describe("New title"),
      start: z.string().optional().describe("New start time (ISO 8601)"),
      end: z.string().optional().describe("New end time (ISO 8601)"),
      description: z.string().optional().describe("New description"),
      location: z.string().optional().describe("New location"),
      calendar_id: z.string().optional().default("primary"),
    }),
    execute: (params: { event_id: string; title?: string; start?: string; end?: string; description?: string; location?: string; calendar_id: string }, _ctx: Tool.Context) =>
      Effect.promise(async () => {
        const patch: any = {}
        if (params.title) patch.summary = params.title
        if (params.start) patch.start = { dateTime: params.start, timeZone: LOCAL_TZ }
        if (params.end) patch.end = { dateTime: params.end, timeZone: LOCAL_TZ }
        if (params.description) patch.description = params.description
        if (params.location) patch.location = params.location

        await googleFetch(`${BASE}/calendars/${encodeURIComponent(params.calendar_id)}/events/${params.event_id}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        })

        return { title: "Event updated", output: `Event ${params.event_id} updated.`, metadata: { event_id: params.event_id } }
      }),
  }),
)

export const CalendarDeleteTool = Tool.define(
  "calendar_delete",
  Effect.succeed({
    description: "Delete a calendar event.",
    parameters: z.object({
      event_id: z.string().describe("The event ID to delete"),
      calendar_id: z.string().optional().default("primary"),
    }),
    execute: (params: { event_id: string; calendar_id: string }, _ctx: Tool.Context) =>
      Effect.promise(async () => {
        const token = (await import("./auth")).GoogleAuth.getAccessToken()
        if (!token) throw new Error((await import("./auth")).GoogleAuth.authErrorMessage())

        await fetch(`${BASE}/calendars/${encodeURIComponent(params.calendar_id)}/events/${params.event_id}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${await (await import("./auth")).GoogleAuth.getAccessToken()}` },
        })

        return { title: "Event deleted", output: `Event ${params.event_id} deleted.`, metadata: { event_id: params.event_id } }
      }),
  }),
)
