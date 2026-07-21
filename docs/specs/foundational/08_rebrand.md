# 08 — Rebrand: OpenCode to FoxyBear

## Objective

Rename all user-visible, config-visible, and identity-bearing references from "OpenCode" / "opencode" to "FoxyBear" / "foxybear". Preserve upstream rebase compatibility by minimizing changes to logic — this is a naming pass only.

## Prior Art

- OpenCode v1.4.3 branding: CLI `opencode`, config `opencode.json`, directory `.opencode/`, mDNS `opencode-{port}`, packages `@opencode-ai/*`
- FoxyBear brand guidelines: `brand/Peak_BrandBook_V2 (2).pdf` — Blue #00B8FC, Pink #FF2D55, gradient topLeft→bottomRight

## Scope Categories

### Category 1: CLI Binary + Entry Point

**WHEN** the CLI binary is invoked,
it **SHALL** be named `foxybear` (not `opencode`).

**WHEN** the binary discovers its path,
it **SHALL** use `FOXYBEAR_BIN_PATH` (not `OPENCODE_BIN_PATH`).

Files:
- `bin/opencode` → `bin/foxybear`
- `package.json` bin field: `"foxybear": "./bin/foxybear"`

### Category 2: TUI Branding

**WHEN** the terminal title is set,
it **SHALL** display "FoxyBear" (not "OpenCode").

**WHEN** the abbreviated title prefix is used,
it **SHALL** use "FB" (not "OC").

**WHEN** tips, help text, or user-facing messages reference the CLI,
they **SHALL** use `foxybear` (not `opencode`).

Files:
- `src/cli/cmd/tui/app.tsx` — terminal title, abbreviation
- `src/cli/cmd/tui/feature-plugins/home/tips-view.tsx` — tip strings
- `src/cli/cmd/tui/component/dialog-provider.tsx` — dialog text
- `src/cli/cmd/tui/component/dialog-go-upsell.tsx` — upsell text
- `src/cli/cmd/tui/feature-plugins/sidebar/footer.tsx` — footer
- All user-facing strings in `src/cli/cmd/tui/`

### Category 3: Config Files + Directories

**WHEN** the app looks for its config file,
it **SHALL** read `foxybear.json` (not `opencode.json`).

**WHEN** the app looks for its data directory,
it **SHALL** use `.foxybear/` (not `.opencode/`).

**WHEN** config paths reference the old names,
they **SHALL** support both old and new names during a transition period (read `foxybear.json`, fall back to `opencode.json` if not found).

Files:
- `opencode.json` → `foxybear.json`
- `src/config/config.ts` — file references
- `src/config/paths.ts` — directory paths
- `src/config/tui.ts`, `src/config/tui-migrate.ts` — config loading
- `src/installation/index.ts` — setup paths
- All references to `.opencode/` directory (agents, tools, plugins, themes, commands, skills)

### Category 4: Effect Service Tags

**WHEN** an Effect service is tagged,
it **SHALL** use `@foxybear/` prefix (not `@opencode/`).

Tags:
- `@opencode/Memory` → `@foxybear/Memory`
- `@opencode/Embedding` → `@foxybear/Embedding`

Files:
- `src/memory/memory.ts`
- `src/memory/embedding.ts`

### Category 5: Package Names

**WHEN** internal packages are referenced,
they **SHALL** use `@foxybear/` scope (not `@opencode-ai/`).

Packages:
- `@opencode-ai/plugin` → `@foxybear/plugin`
- `@opencode-ai/sdk` → `@foxybear/sdk`
- `@opencode-ai/util` → `@foxybear/util`
- `@opencode-ai/script` → `@foxybear/script`

Files:
- `package.json` (dependencies)
- All import statements referencing `@opencode-ai/`
- Package-level `package.json` files in the monorepo

### Category 6: mDNS + Network

**WHEN** the mesh publishes an mDNS service,
it **SHALL** use `foxybear-{port}` (not `opencode-{port}`).

**WHEN** the mDNS domain is set,
it **SHALL** default to `foxybear.local` (not `opencode.local`).

Files:
- `src/server/mdns.ts`

### Category 7: HTTP Headers + API References

**WHEN** the User-Agent header is set,
it **SHALL** use `foxybear` (not `opencode`).

**WHEN** API proxy targets reference `opencode.ai`,
they **SHALL** be updated or made configurable.

Files:
- `src/tool/webfetch.ts` — User-Agent
- `src/server/instance.ts` — API proxy target

### Category 8: Schema URLs

**WHEN** `$schema` references point to `opencode.ai`,
they **SHALL** be updated to the FoxyBear schema host (or removed if self-hosted schemas aren't available yet).

Files:
- `foxybear.json` (was `opencode.json`) — `$schema` field
- Theme config files

### Category 9: Auth Packages

**WHEN** auth packages reference `opencode`,
they **SHALL** be evaluated for replacement or removal.

Packages (external — may need forking or replacing):
- `@gitlab/opencode-gitlab-auth`
- `opencode-gitlab-auth`
- `opencode-poe-auth`

Note: These are external npm packages. If they can't be renamed, keep as-is and document.

## Verification

```bash
bun test --timeout 30000

# After rebrand:
# grep -r "opencode" src/ --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".git"
# Should return ZERO hits (except auth package imports if kept)

# CLI invocation test:
# foxybear --version  (should work)
# foxybear serve      (should work)

# Config migration test:
# Place foxybear.json in project root → app reads it
# Place opencode.json (no foxybear.json) → app reads it (backward compat)
```

## Boundaries

- Rebrand does NOT change any logic, algorithms, or behavior
- Rebrand does NOT modify test assertions that reference internal identifiers (update references only)
- Rebrand does NOT fork or modify external auth packages (document as-is)
- Rebrand does NOT change the git remote names (`origin`, `upstream`)
- Rebrand DOES preserve backward compatibility for config file names during transition
