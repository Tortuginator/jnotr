#!/usr/bin/env bun
// Self-contained CLI for reading public job lists from Visma Talent career
// sites ("hire.vismatalent.com"), the platform Visma is migrating Webcruiter
// customers onto. Zero runtime dependencies: Bun + fetch + regex.

import { runSearch, type SearchOpts } from "./commands/search.js"
import { runDetail, type DetailOpts } from "./commands/detail.js"

interface Flags {
  _: string[]
  [k: string]: string | boolean | string[]
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { _: [] }
  const alias: Record<string, string> = { q: "query", l: "location" }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--") || a.startsWith("-")) {
      const key = alias[a.replace(/^-+/, "")] ?? a.replace(/^-+/, "")
      const next = argv[i + 1]
      if (next === undefined || next.startsWith("-")) {
        flags[key] = true
      } else {
        flags[key] = next
        i++
      }
    } else {
      ;(flags._ as string[]).push(a)
    }
  }
  return flags
}

const HELP = `vismatalent-search-cli — read public Visma Talent job lists for Norwegian employers

USAGE
  bun run src/cli.ts search [flags]
  bun run src/cli.ts detail <siteGuid:jobGuid|jobGuid|url> [--format json|plain]

SEARCH FLAGS
  --query, -q <text>      Keywords matched against the title and description.
  --location, -l <text>   "area" for the Trondheim commute area (job_scraper/area.json),
                          or a municipality/county/country/place name. Omit for no filter.
  --jobage <days>         Keep postings published within N days. Undated postings are dropped.
  --page <n>              1-indexed page of the pooled results. Default 1.
  --limit <n>             Page size and cap on emitted results. Default 50.
  --format <fmt>          json (default) | table | plain.

EXAMPLES
  bun run src/cli.ts search -l area --limit 10 --format table
  bun run src/cli.ts search -q utvikler --format json
  bun run src/cli.ts search -q kokk -l Stavanger --jobage 14 --format table
  bun run src/cli.ts detail 0ceb6ff0-777f-4216-93b6-be2d4ae34a16:821f710e-4079-45b1-a3b1-27b410df725d --format plain
  bun run src/cli.ts detail "https://hire.vismatalent.com/Public/Assignment.aspx?guidAssignment=821f710e-4079-45b1-a3b1-27b410df725d&language=nb" --format plain

Public JSON API, but hire.vismatalent.com robots.txt disallows generic crawlers.
Keep volume low; run this on your own responsibility (see SKILL.md).
`

const KNOWN_FLAGS: Record<string, Set<string>> = {
  search: new Set(["query", "location", "jobage", "page", "limit", "format", "help", "h"]),
  detail: new Set(["format", "help", "h"]),
}

function badArg(error: string, code = "BAD_ARG"): number {
  process.stderr.write(JSON.stringify({ error, code }) + "\n")
  return 1
}

function parseIntFlag(name: string, raw: string | boolean | string[]): number | null {
  const value = typeof raw === "string" ? Number(raw.trim()) : NaN
  if (!Number.isInteger(value) || value < 1) {
    badArg(`--${name} must be a whole number of at least 1, got "${String(raw)}"`)
    return null
  }
  return value
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const flags = parseFlags(argv)
  const cmd = (flags._ as string[])[0]

  if (!cmd || flags.help || flags.h) {
    process.stdout.write(HELP)
    return cmd ? 0 : 1
  }

  const knownFlags = KNOWN_FLAGS[cmd]
  if (knownFlags) {
    for (const key of Object.keys(flags)) {
      if (key === "_" || knownFlags.has(key)) continue
      return badArg(
        `unknown flag --${key} for '${cmd}' - flags are never silently ignored; see --help for the supported flags`,
        "UNKNOWN_FLAG",
      )
    }
  }

  if (cmd === "search") {
    if (flags.query !== undefined && (typeof flags.query !== "string" || !flags.query.trim())) {
      return badArg("--query requires a non-empty value")
    }
    if (flags.location !== undefined && (typeof flags.location !== "string" || !flags.location.trim())) {
      return badArg('--location requires a non-empty value ("area" or a municipality/place)')
    }

    const fmt = flags.format !== undefined ? String(flags.format) : "json"
    if (!["json", "table", "plain"].includes(fmt)) {
      return badArg(`--format must be one of json|table|plain, got "${fmt}"`)
    }

    let jobage: number | undefined
    let page = 1
    let limit: number | undefined
    if (flags.jobage !== undefined) {
      const value = parseIntFlag("jobage", flags.jobage)
      if (value === null) return 1
      jobage = value
    }
    if (flags.page !== undefined) {
      const value = parseIntFlag("page", flags.page)
      if (value === null) return 1
      page = value
    }
    if (flags.limit !== undefined) {
      const value = parseIntFlag("limit", flags.limit)
      if (value === null) return 1
      limit = value
    }

    const opts: SearchOpts = {
      query: typeof flags.query === "string" ? flags.query : undefined,
      location: typeof flags.location === "string" ? flags.location : undefined,
      jobage,
      page,
      limit,
      format: fmt as SearchOpts["format"],
    }
    return runSearch(opts)
  }

  if (cmd === "detail") {
    const id = (flags._ as string[])[1]
    if (!id) return badArg("detail requires a <siteGuid:jobGuid|jobGuid|url>", "NO_ID")
    const fmt = flags.format !== undefined ? String(flags.format) : "json"
    if (!["json", "plain"].includes(fmt)) {
      return badArg(`--format must be one of json|plain, got "${fmt}"`)
    }
    const opts: DetailOpts = { id, format: fmt as DetailOpts["format"] }
    return runDetail(opts)
  }

  return badArg(`Unknown command "${cmd}"`, "BAD_CMD")
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stderr.write(
      JSON.stringify({
        error: e instanceof Error ? e.message : String(e),
        code: "INTERNAL_ERROR",
      }) + "\n",
    )
    process.exit(1)
  })
