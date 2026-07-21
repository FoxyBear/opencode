#!/usr/bin/env bun
/**
 * Import memories from JSON backup into SurrealDB server.
 *
 * Usage: bun run script/import-surreal.ts [backup-file]
 *
 * Requires SurrealDB server running at ws://127.0.0.1:8000
 */

import { Surreal, RecordId, Table } from "surrealdb"

const backupPath = process.argv[2] ?? `${process.env.HOME}/.local/share/opencode/memory-backup-1778057881365.json`
const NEW_URL = process.env.NEW_SURREAL_URL ?? "ws://127.0.0.1:8000"

console.log(`Backup: ${backupPath}`)
console.log(`Target: ${NEW_URL}`)

const backup = await Bun.file(backupPath).json()
console.log(`\nRecords in backup:`)
console.log(`  memories:   ${backup.memories?.length ?? 0}`)
console.log(`  entities:   ${backup.entities?.length ?? 0}`)
console.log(`  mentions:   ${backup.mentions?.length ?? 0}`)
console.log(`  relates:    ${backup.relates?.length ?? 0}`)
console.log(`  supersedes: ${backup.supersedes?.length ?? 0}`)

const db = new Surreal()
await db.connect(NEW_URL)
await db.signin({ username: "root", password: "root" })
await db.use({ namespace: "foxybear", database: "memory" })

await db.query(`
  DEFINE TABLE IF NOT EXISTS memory SCHEMALESS;
  DEFINE TABLE IF NOT EXISTS entity SCHEMALESS;
  DEFINE TABLE IF NOT EXISTS mentions TYPE RELATION FROM memory TO entity SCHEMALESS;
  DEFINE TABLE IF NOT EXISTS relates TYPE RELATION FROM entity TO entity SCHEMALESS;
  DEFINE TABLE IF NOT EXISTS supersedes TYPE RELATION FROM memory TO memory SCHEMALESS;
`)

function extractId(raw: any, table: string): string {
  if (typeof raw === "object" && raw.id) return String(raw.id)
  return String(raw).replace(`${table}:`, "")
}

function toRecordId(raw: any, fallbackTable: string): RecordId {
  if (typeof raw === "object" && raw.tb && raw.id != null) {
    return new RecordId(raw.tb, String(raw.id))
  }
  const str = String(raw)
  const colonIdx = str.indexOf(":")
  if (colonIdx > 0) {
    return new RecordId(str.slice(0, colonIdx), str.slice(colonIdx + 1))
  }
  return new RecordId(fallbackTable, str)
}

console.log(`\nImporting...`)

let count = 0
for (const m of (backup.memories ?? [])) {
  const id = extractId(m.id, "memory")
  const record = { ...m }
  delete record.id
  await db.create(new RecordId("memory", id)).content(record)
  count++
  if (count % 10 === 0) process.stdout.write(`\r  memories: ${count}`)
}
console.log(`\r  memories: ${count}`)

let entCount = 0
for (const e of (backup.entities ?? [])) {
  const id = extractId(e.id, "entity")
  const record = { ...e }
  delete record.id
  await db.create(new RecordId("entity", id)).content(record)
  entCount++
  if (entCount % 50 === 0) process.stdout.write(`\r  entities: ${entCount}`)
}
console.log(`\r  entities: ${entCount}`)

let relCount = 0
for (const r of (backup.mentions ?? [])) {
  const from = toRecordId(r.in, "memory")
  const to = toRecordId(r.out, "entity")
  const record = { ...r }
  delete record.id; delete record.in; delete record.out
  await db.relate(from, new Table("mentions"), to, record)
  relCount++
  if (relCount % 50 === 0) process.stdout.write(`\r  mentions: ${relCount}`)
}
console.log(`\r  mentions: ${relCount}`)

for (const r of (backup.relates ?? [])) {
  const from = toRecordId(r.in, "entity")
  const to = toRecordId(r.out, "entity")
  const record = { ...r }
  delete record.id; delete record.in; delete record.out
  await db.relate(from, new Table("relates"), to, record)
  relCount++
}

for (const r of (backup.supersedes ?? [])) {
  const from = toRecordId(r.in, "memory")
  const to = toRecordId(r.out, "memory")
  const record = { ...r }
  delete record.id; delete record.in; delete record.out
  await db.relate(from, new Table("supersedes"), to, record)
  relCount++
}

await db.close()
console.log(`\nDone. ${count + entCount + relCount} records imported.`)
