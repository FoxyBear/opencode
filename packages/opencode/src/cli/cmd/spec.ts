import fs from "fs/promises"
import path from "path"
import { cmd } from "./cmd"
import { validateRequirement, validateSpec, generateSpecFromRequirement } from "../../spec-pipeline"

export const SpecCommand = cmd({
  command: "spec <action>",
  describe: "spec pipeline: generate, validate, index, review",
  builder: (yargs) =>
    yargs
      .positional("action", {
        type: "string" as const,
        describe: "generate | validate | index | review",
        choices: ["generate", "validate", "index", "review"] as const,
      })
      .option("file", {
        type: "string" as const,
        alias: "f",
        describe: "input file (requirement.yaml for generate, spec.md for validate/review)",
      })
      .option("no-agent", {
        type: "boolean" as const,
        describe: "skip agent-assisted drafting (generate only)",
        default: false,
      })
      .option("spec-dir", {
        type: "string" as const,
        describe: "spec directory",
        default: "spec",
      }),
  handler: async (args) => {
    const action = args.action as string

    switch (action) {
      case "validate": {
        if (!args.file) {
          console.error("Usage: foxybear spec validate --file <spec.md>")
          process.exit(1)
        }
        const content = await fs.readFile(args.file, "utf-8")
        const result = validateSpec(content)

        if (result.valid) {
          console.log(`Spec valid: ${result.stats.statements} statements, ${result.stats.test_cases} test cases.`)
          console.log(`Sections: ${result.stats.sections.join(", ")}`)
        } else {
          console.error("Validation failed:")
          for (const err of result.errors) {
            const prefix = err.severity === "error" ? "ERROR" : "WARN"
            console.error(`  [${prefix}] ${err.message}${err.line > 0 ? ` (line ${err.line})` : ""}`)
          }
          process.exit(1)
        }
        break
      }

      case "generate": {
        if (!args.file) {
          console.error("Usage: foxybear spec generate --file <requirement.yaml>")
          process.exit(1)
        }
        const raw = await fs.readFile(args.file, "utf-8")
        const { doc, errors } = await validateRequirement(raw, args.specDir)

        if (errors.length > 0) {
          console.error("Requirement validation failed:")
          for (const err of errors) {
            console.error(`  [${err.field}] ${err.message}`)
          }
          process.exit(1)
        }

        const specNumber = doc.id.replace("REQ-", "")
        const specContent = generateSpecFromRequirement(doc, specNumber)
        const outFile = path.join(args.specDir, `${specNumber}-${doc.title.toLowerCase().replace(/\s+/g, "-")}.md`)

        await fs.mkdir(args.specDir, { recursive: true })
        await fs.writeFile(outFile, specContent)
        console.log(`Spec generated: ${outFile}`)
        console.log(`Note: Behavior section needs WHEN/SHALL statements.${args.noAgent ? "" : " Run with --no-agent to skip agent drafting."}`)
        break
      }

      case "index": {
        const specDir = args.specDir
        const files = await fs.readdir(specDir).catch(() => [])
        const specs = []

        for (const file of files) {
          if (!file.endsWith(".md") || file === "INDEX.md") continue
          const content = await fs.readFile(path.join(specDir, file), "utf-8")
          const titleMatch = content.match(/^#\s+(\d+)\s+—\s+(.+)/m)
          const statementCount = (content.match(/\*\*WHEN\*\*/g) ?? []).length

          specs.push({
            number: titleMatch?.[1] ?? "?",
            title: titleMatch?.[2] ?? file,
            file,
            statements: statementCount,
          })
        }

        specs.sort((a, b) => Number(a.number) - Number(b.number))

        const { generateIndex } = await import("../../spec-pipeline/generator")
        const index = generateIndex(specs)
        await fs.writeFile(path.join(specDir, "INDEX.md"), index)
        console.log(`Index regenerated: ${specs.length} specs`)
        break
      }

      case "review": {
        if (!args.file) {
          console.error("Usage: foxybear spec review --file <spec.md>")
          process.exit(1)
        }
        console.log("Spec review requires an agent session. Use the TUI to review specs interactively.")
        console.log(`File: ${args.file}`)
        break
      }
    }
  },
})
