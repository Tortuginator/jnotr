#!/usr/bin/env bun
// Self-contained CLI for reading public ReachMee job lists for every enabled
// ReachMee employer in job_scraper/employers.csv. Zero runtime dependencies:
// Bun + fetch + regex.

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

const HELP = `reachmee-search-cli — read public ReachMee job lists for Trondheim employers

USAGE
  bun run src/cli.ts search [flags]
  bun run src/cli.ts detail <posting-url> [--format json|plain]

SEARCH FLAGS
  --query, -q <text>      Keywords matched against title, company and list text.
  --location, -l <text>   "area" for the Trondheim commute area (job_scraper/area.json),
                          or a municipality/place/city name. Omit for no filter.
  --jobage <days>         Keep postings with a published date within N days.
                          Lists that only expose a deadline are dropped by this filter.
  --location-detail-limit <n>
                          For list rows that omit location, fetch up to N detail
                          pages to find one when --location is set. Default 30.
  --page <n>              1-indexed page of the pooled results. Default 1.
  --limit <n>             Page size and cap on emitted results. Default 50.
  --format <fmt>          json (default) | table | plain.

EXAMPLES
  bun run src/cli.ts search --limit 10 --format table
  bun run src/cli.ts search -q sommerjobb -l area --format table
  bun run src/cli.ts search -q ingeniør --format json
  bun run src/cli.ts detail "https://web103.reachmee.com/ext/I010/2581/job?site=6&lang=NO&validator=...&job_id=215" --format plain

ReachMee's public list pages require a per-customer validator or an Attract site.
The skill discovers what it can from each employer's career page. Keep volume low;
run this on your own responsibility (see SKILL.md).
`

const KNOWN_FLAGS: Record<string, Set<string>> = {
  search: new Set(["query", "location", "jobage", "location-detail-limit", "page", "limit", "format", "help", "h"]),
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
      return badArg("--location requires a non-empty value (\"area\" or a municipality/place)")
    }

    const fmt = flags.format !== undefined ? String(flags.format) : "json"
    if (!["json", "table", "plain"].includes(fmt)) {
      return badArg(`--format must be one of json|table|plain, got "${fmt}"`)
    }

    let jobage: number | undefined
    let locationDetailLimit = 30
    let page = 1
    let limit: number | undefined
    if (flags["location-detail-limit"] !== undefined) {
      const value = parseIntFlag("location-detail-limit", flags["location-detail-limit"])
      if (value === null) return 1
      locationDetailLimit = value
    }
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
      locationDetailLimit,
      page,
      limit,
      format: fmt as SearchOpts["format"],
    }
    return runSearch(opts)
  }

  if (cmd === "detail") {
    const id = (flags._ as string[])[1]
    if (!id) return badArg("detail requires a <posting-url>", "NO_ID")
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
