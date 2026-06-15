import z from "zod"
import { Effect } from "effect"
import { Tool } from "../tool/tool"
import { googleFetch } from "./api"

const BASE = "https://people.googleapis.com/v1"

export const ContactsSearchTool = Tool.define(
  "contacts_search",
  Effect.succeed({
    description: "Search Google Contacts by name, email, or phone.",
    parameters: z.object({
      query: z.string().describe("Search query (name, email, or phone)"),
      max_results: z.number().optional().default(10).describe("Maximum results"),
    }),
    execute: (params: { query: string; max_results: number }, _ctx: Tool.Context) =>
      Effect.promise(async () => {
        const data = await googleFetch(
          `${BASE}/people:searchContacts?query=${encodeURIComponent(params.query)}&readMask=names,emailAddresses,phoneNumbers,organizations&pageSize=${params.max_results}`,
        )

        if (!data.results?.length) return { title: "No contacts found", output: "No contacts match the query.", metadata: { count: 0 } }

        const lines = data.results.map((r: any) => {
          const p = r.person
          const name = p.names?.[0]?.displayName ?? "(unnamed)"
          const email = p.emailAddresses?.[0]?.value ?? ""
          const phone = p.phoneNumbers?.[0]?.value ?? ""
          const org = p.organizations?.[0]?.name ?? ""
          return `- **${name}**${email ? ` | ${email}` : ""}${phone ? ` | ${phone}` : ""}${org ? ` | ${org}` : ""}\n  Resource: ${p.resourceName}`
        })

        return { title: `${data.results.length} contacts`, output: lines.join("\n"), metadata: { count: data.results.length } }
      }),
  }),
)

export const ContactsGetTool = Tool.define(
  "contacts_get",
  Effect.succeed({
    description: "Get full details of a Google Contact by resource name.",
    parameters: z.object({
      resource_name: z.string().describe("Contact resource name (e.g., 'people/c12345')"),
    }),
    execute: (params: { resource_name: string }, _ctx: Tool.Context) =>
      Effect.promise(async () => {
        const data = await googleFetch(
          `${BASE}/${params.resource_name}?personFields=names,emailAddresses,phoneNumbers,organizations,addresses,birthdays,biographies`,
        )

        const name = data.names?.[0]?.displayName ?? "(unnamed)"
        const lines = [`**${name}**`]
        if (data.emailAddresses?.length) lines.push(`Emails: ${data.emailAddresses.map((e: any) => e.value).join(", ")}`)
        if (data.phoneNumbers?.length) lines.push(`Phones: ${data.phoneNumbers.map((p: any) => p.value).join(", ")}`)
        if (data.organizations?.length) lines.push(`Org: ${data.organizations.map((o: any) => `${o.name ?? ""}${o.title ? ` (${o.title})` : ""}`).join(", ")}`)
        if (data.addresses?.length) lines.push(`Address: ${data.addresses[0].formattedValue ?? ""}`)
        if (data.birthdays?.length) {
          const b = data.birthdays[0].date
          if (b) lines.push(`Birthday: ${b.year ?? "??"}-${String(b.month).padStart(2, "0")}-${String(b.day).padStart(2, "0")}`)
        }

        return { title: name, output: lines.join("\n"), metadata: { resource_name: params.resource_name } }
      }),
  }),
)

export const ContactsCreateTool = Tool.define(
  "contacts_create",
  Effect.succeed({
    description: "Create a new Google Contact. Returns the resource name.",
    parameters: z.object({
      name: z.string().describe("Contact full name"),
      email: z.string().optional().describe("Email address"),
      phone: z.string().optional().describe("Phone number"),
      organization: z.string().optional().describe("Organization name"),
    }),
    execute: (params: { name: string; email?: string; phone?: string; organization?: string }, _ctx: Tool.Context) =>
      Effect.promise(async () => {
        const person: any = {
          names: [{ givenName: params.name.split(" ")[0], familyName: params.name.split(" ").slice(1).join(" ") || undefined }],
        }
        if (params.email) person.emailAddresses = [{ value: params.email }]
        if (params.phone) person.phoneNumbers = [{ value: params.phone }]
        if (params.organization) person.organizations = [{ name: params.organization }]

        const data = await googleFetch(`${BASE}/people:createContact`, {
          method: "POST",
          body: JSON.stringify(person),
        })

        return { title: "Contact created", output: `Contact "${params.name}" created. Resource: ${data.resourceName}`, metadata: { resource_name: data.resourceName } }
      }),
  }),
)

export const ContactsUpdateTool = Tool.define(
  "contacts_update",
  Effect.succeed({
    description: "Update fields on an existing Google Contact.",
    parameters: z.object({
      resource_name: z.string().describe("Contact resource name"),
      name: z.string().optional().describe("New full name"),
      email: z.string().optional().describe("New email"),
      phone: z.string().optional().describe("New phone"),
      organization: z.string().optional().describe("New organization"),
    }),
    execute: (params: { resource_name: string; name?: string; email?: string; phone?: string; organization?: string }, _ctx: Tool.Context) =>
      Effect.promise(async () => {
        const updateFields: string[] = []
        const person: any = {}

        if (params.name) {
          person.names = [{ givenName: params.name.split(" ")[0], familyName: params.name.split(" ").slice(1).join(" ") || undefined }]
          updateFields.push("names")
        }
        if (params.email) { person.emailAddresses = [{ value: params.email }]; updateFields.push("emailAddresses") }
        if (params.phone) { person.phoneNumbers = [{ value: params.phone }]; updateFields.push("phoneNumbers") }
        if (params.organization) { person.organizations = [{ name: params.organization }]; updateFields.push("organizations") }

        await googleFetch(
          `${BASE}/${params.resource_name}:updateContact?updatePersonFields=${updateFields.join(",")}`,
          { method: "PATCH", body: JSON.stringify(person) },
        )

        return { title: "Contact updated", output: `Contact ${params.resource_name} updated.`, metadata: { resource_name: params.resource_name } }
      }),
  }),
)
