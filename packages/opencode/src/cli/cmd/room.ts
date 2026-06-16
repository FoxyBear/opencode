import { cmd } from "./cmd"
import { CleanRoom } from "../../clean-room"

export const RoomCommand = cmd({
  command: "room <action>",
  describe: "clean room: isolated spec execution environments",
  builder: (yargs) =>
    yargs
      .positional("action", {
        type: "string" as const,
        describe: "create | run | validate | review | merge | discard | list | inspect",
        choices: ["create", "run", "validate", "review", "merge", "discard", "list", "inspect"] as const,
      })
      .option("file", {
        type: "string" as const,
        alias: "f",
        describe: "spec file (for create)",
      })
      .option("id", {
        type: "string" as const,
        describe: "room ID (for run/validate/review/merge/discard/inspect)",
      })
      .option("branch", {
        type: "string" as const,
        describe: "custom branch name (for create)",
      }),
  handler: async (args) => {
    const action = args.action as string

    switch (action) {
      case "create": {
        if (!args.file) { console.error("Usage: foxybear room create --file <spec.md>"); process.exit(1) }
        const room = await CleanRoom.create(args.file, { branch: args.branch })
        console.log(`Room created: ${room.id}`)
        console.log(`Worktree: ${room.worktree_path}`)
        console.log(`Branch: ${room.branch}`)
        break
      }
      case "run": {
        if (!args.id) { console.error("Usage: foxybear room run --id <room-id>"); process.exit(1) }
        const room = await CleanRoom.run(args.id)
        console.log(`Room ${room.id}: ${room.state}`)
        if (room.duration_ms) console.log(`Duration: ${Math.round(room.duration_ms / 1000)}s`)
        if (room.diff_stat) console.log(`Diff: ${room.diff_stat.files} files, +${room.diff_stat.insertions}/-${room.diff_stat.deletions}`)
        break
      }
      case "validate": {
        if (!args.id) { console.error("Usage: foxybear room validate --id <room-id>"); process.exit(1) }
        const room = await CleanRoom.validate(args.id)
        console.log(`Room ${room.id}: ${room.state}`)
        for (const r of room.validation_results ?? []) {
          console.log(`  ${r.passed ? "PASS" : "FAIL"} ${r.step}: ${r.details}`)
        }
        break
      }
      case "review": {
        if (!args.id) { console.error("Usage: foxybear room review --id <room-id>"); process.exit(1) }
        console.log("Room review requires an agent session. Use the TUI.")
        break
      }
      case "merge": {
        if (!args.id) { console.error("Usage: foxybear room merge --id <room-id>"); process.exit(1) }
        const room = await CleanRoom.merge(args.id)
        console.log(`Room ${room.id}: merged into ${room.source_branch}`)
        break
      }
      case "discard": {
        if (!args.id) { console.error("Usage: foxybear room discard --id <room-id>"); process.exit(1) }
        const room = await CleanRoom.discard(args.id)
        console.log(`Room ${room.id}: discarded`)
        break
      }
      case "list": {
        const rooms = await CleanRoom.list()
        if (rooms.length === 0) { console.log("No rooms."); break }
        for (const r of rooms) {
          console.log(`${r.id} [${r.state}] — ${r.spec_title} (${r.created_at})`)
        }
        break
      }
      case "inspect": {
        if (!args.id) { console.error("Usage: foxybear room inspect --id <room-id>"); process.exit(1) }
        const room = await CleanRoom.get(args.id)
        if (!room) { console.error(`Room not found: ${args.id}`); process.exit(1) }
        console.log(JSON.stringify(room, null, 2))
        break
      }
    }
  },
})
