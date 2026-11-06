#!/usr/bin/env bun
// Self-contained CLI for NAV Arbeidsplassen's job-vacancy feed. The feed is a
// change log, so `sync` keeps a local cache and `search` queries that cache;
// `detail` asks NAV for one ad's full description. Zero runtime dependencies.

import { runSearch, type SearchOpts } from "./commands/search.js"
import { runDetail, type DetailOpts } from "./commands/detail.js"
import { runSync, type SyncOptions } from "./commands/sync.js"
import { resolvePaths } from "./helpers.js"

interface Flags {
  _: string[]
  [key: string]: string | boolean | string[]
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { _: [] }
  const alias: Record<string, string> = { q: "query", l: "location", n: "limit" }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith("--") && arg.includes("=")) {
      const eq = arg.indexOf("=")
      const rawKey = arg.slice(2, eq)
      const key = alias[rawKey] ?? rawKey
      flags[key] = arg.slice(eq + 1)
      continue
    }
    if (arg.startsWith("--") || arg.startsWith("-")) {
      const key = alias[arg.replace(/^-+/, "")] ?? arg.replace(/^-+/, "")
      const next = argv[i + 1]
      if (next === undefined || next.startsWith("-")) {
        flags[key] = true
      } else {
        flags[key] = next
        i++
      }
    } else {
      flags._.push(arg)
    }
  }
  return flags
}

const HELP = `nav-search-cli — search Norwegian job vacancies from NAV Arbeidsplassen

USAGE
  bun run src/cli.ts sync [--since <days>] [--max-pages <n>] [--details-limit <n>] [--dry-run]
  bun run src/cli.ts search [-q <text>] [-l <municipality|area>] [flags]
  bun run src/cli.ts detail <uuid|url> [--format json|plain]

SETUP
  export NAV_API_TOKEN="<private token from NAV>"
  Request a private token from nav.team.arbeidsplassen@nav.no and accept the
  terms at https://arbeidsplassen.nav.no/vilkar-api. A rotating public token
  for experiments is at https://pam-stilling-feed.nav.no/api/publicToken, but
  it is not suitable for routine use.

SYNC FLAGS
  --since <days>      Only keep changes from the last N days. Default: 30.
  --max-pages <n>     Maximum feed pages to pull this run. Default: 20.
  --details-limit <n> Fetch full descriptions for up to N new active ads so
                      --query can match description text. Default: 25. 0 disables.
  --dry-run           Fetch and report but do not write the cache or cursor.

SEARCH FLAGS
  --query, -q <text>          Keywords matched against title and description.
  --location, -l <place>      "area" for the Trondheim commute area, a
                              municipality name such as "Trondheim", or omit
                              for no location filter.
  --jobage <days>             Published/changed within N days (client-side).
  --page <n>                  1-indexed page. Default: 1.
  --limit, -n <n>             Results per page. Default: 20.
  --max-age-minutes <n>       Refresh the cache when older than N minutes.
                              Default: 30 (only when NAV_API_TOKEN is set).
  --format json|table|plain   Output format. Default: json.

DETAIL FLAGS
  --format json|plain         Output format. Default: json.

CACHE
  job_scraper/nav_cache.jsonl       one normalized record per ad
  job_scraper/nav_feed_state.json   feed cursor and last sync time

EXAMPLES
  bun run src/cli.ts sync --since 7 --max-pages 2
  bun run src/cli.ts search -q utvikler -l area --limit 4 --format table
  bun run src/cli.ts search -q "data engineer" -l Trondheim --jobage 14
  bun run src/cli.ts search -l area --format table
  bun run src/cli.ts detail 1306dcfd-f0c5-4fba-8835-d9a456dbd6b3 --format plain
  bun run src/cli.ts detail https://pam-stilling-feed.nav.no/api/v1/feedentry/<uuid>
`

const KNOWN_FLAGS: Record<string, Set<string>> = {
  search: new Set([
    "location", "query", "jobage", "page", "limit", "max-age-minutes", "format", "help", "h",
  ]),
  detail: new Set(["format", "help", "h"]),
  sync: new Set(["since", "max-pages", "details-limit", "dry-run", "help", "h"]),
}

function positiveInt(name: string, raw: string | boolean | string[]): number | null {
  const value = typeof raw === "string" ? Number(raw.trim()) : NaN
  if (!Number.isInteger(value) || value < 1) {
    process.stderr.write(
      JSON.stringify({
        error: `--${name} must be a whole number of at least 1, got "${String(raw)}"`,
        code: "BAD_ARG",
      }) + "\n",
    )
    return null
  }
  return value
}

function nonNegativeInt(name: string, raw: string | boolean | string[]): number | null {
  const value = typeof raw === "string" ? Number(raw.trim()) : NaN
  if (!Number.isInteger(value) || value < 0) {
    process.stderr.write(
      JSON.stringify({
        error: `--${name} must be a whole number of at least 0, got "${String(raw)}"`,
        code: "BAD_ARG",
      }) + "\n",
    )
    return null
  }
  return value
}

function requireStringFlag(flags: Flags, name: string): string | null {
  const value = flags[name]
  if (value === undefined) return null
  if (typeof value !== "string" || !value.trim()) {
    process.stderr.write(
      JSON.stringify({ error: `--${name} requires a non-empty value`, code: "BAD_ARG" }) + "\n",
    )
    return null
  }
  return value
}

function rejectPositionals(flags: Flags, allowed: number): boolean {
  if (flags._.length > allowed) {
    process.stderr.write(
      JSON.stringify({
        error: `unexpected positional argument "${flags._[allowed]}"`,
        code: "BAD_ARG",
      }) + "\n",
    )
    return false
  }
  return true
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const flags = parseFlags(argv)
  const cmd = flags._[0]

  if (!cmd || flags.help || flags.h) {
    process.stdout.write(HELP)
    return cmd ? 0 : 1
  }

  const knownFlags = KNOWN_FLAGS[cmd]
  if (!knownFlags) {
    process.stderr.write(JSON.stringify({ error: `Unknown command "${cmd}"`, code: "BAD_CMD" }) + "\n")
    return 1
  }
  for (const key of Object.keys(flags)) {
    if (key === "_" || knownFlags.has(key)) continue
    process.stderr.write(
      JSON.stringify({
        error: `unknown flag --${key} for '${cmd}' - flags are never silently ignored; see --help for the supported flags`,
        code: "UNKNOWN_FLAG",
      }) + "\n",
    )
    return 1
  }

  if (cmd === "search") {
    if (!rejectPositionals(flags, 1)) return 1

    const query = requireStringFlag(flags, "query")
    if (query === null && flags.query !== undefined) return 1
    const location = requireStringFlag(flags, "location")
    if (location === null && flags.location !== undefined) return 1

    const format = flags.format !== undefined ? String(flags.format) : "json"
    if (!["json", "table", "plain"].includes(format)) {
      process.stderr.write(
        JSON.stringify({ error: `--format must be one of json|table|plain, got "${format}"`, code: "BAD_ARG" }) + "\n",
      )
      return 1
    }

    let jobage: number | undefined
    if (flags.jobage !== undefined) {
      const value = positiveInt("jobage", flags.jobage)
      if (value === null) return 1
      jobage = value
    }
    let page = 1
    if (flags.page !== undefined) {
      const value = positiveInt("page", flags.page)
      if (value === null) return 1
      page = value
    }
    let limit: number | undefined
    if (flags.limit !== undefined) {
      const value = positiveInt("limit", flags.limit)
      if (value === null) return 1
      limit = value
    }
    let maxAgeMinutes = 30
    if (flags["max-age-minutes"] !== undefined) {
      const value = positiveInt("max-age-minutes", flags["max-age-minutes"])
      if (value === null) return 1
      maxAgeMinutes = value
    }

    const opts: SearchOpts = {
      query: query ?? undefined,
      location: location ?? undefined,
      jobage,
      page,
      limit,
      maxAgeMinutes,
      format: format as SearchOpts["format"],
    }
    return runSearch(opts)
  }

  if (cmd === "detail") {
    if (!rejectPositionals(flags, 2)) return 1
    const id = flags._[1]
    if (!id) {
      process.stderr.write(JSON.stringify({ error: "detail requires an <id|url>", code: "NO_ID" }) + "\n")
      return 1
    }
    const format = flags.format !== undefined ? String(flags.format) : "json"
    if (!["json", "plain"].includes(format)) {
      process.stderr.write(
        JSON.stringify({ error: `--format must be one of json|plain, got "${format}"`, code: "BAD_ARG" }) + "\n",
      )
      return 1
    }
    const opts: DetailOpts = { id, format: format as DetailOpts["format"] }
    return runDetail(opts)
  }

  if (cmd === "sync") {
    if (!rejectPositionals(flags, 1)) return 1
    let sinceDays = 30
    if (flags.since !== undefined) {
      const value = positiveInt("since", flags.since)
      if (value === null) return 1
      sinceDays = value
    }
    let maxPages = 20
    if (flags["max-pages"] !== undefined) {
      const value = positiveInt("max-pages", flags["max-pages"])
      if (value === null) return 1
      maxPages = value
    }
    let detailsLimit = 25
    if (flags["details-limit"] !== undefined) {
      const value = nonNegativeInt("details-limit", flags["details-limit"])
      if (value === null) return 1
      detailsLimit = value
    }
    let dryRun = false
    if (flags["dry-run"] !== undefined) {
      if (flags["dry-run"] !== true) {
        process.stderr.write(
          JSON.stringify({ error: "--dry-run takes no value", code: "BAD_ARG" }) + "\n",
        )
        return 1
      }
      dryRun = true
    }
    const opts: SyncOptions = {
      sinceDays,
      maxPages,
      dryRun,
      detailsLimit,
      token: process.env.NAV_API_TOKEN?.trim() ?? "",
      paths: resolvePaths(),
    }
    return runSync(opts)
  }

  process.stderr.write(JSON.stringify({ error: `Unknown command "${cmd}"`, code: "BAD_CMD" }) + "\n")
  return 1
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        code: "INTERNAL_ERROR",
      }) + "\n",
    )
    process.exit(1)
  })
