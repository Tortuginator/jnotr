#!/usr/bin/env bun
// Self-contained CLI for searching public EasyCruit career sites across the
// Trondheim employer registry. No credentials and zero runtime dependencies.

import { runSearch, type SearchOpts } from "./commands/search.js"
import { runDetail, type DetailOpts } from "./commands/detail.js"

interface Flags {
  _: string[]
  [k: string]: string | boolean | string[]
}

const ALIAS: Record<string, string> = { q: "query", l: "location", n: "limit" }

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith("-")) {
      const key = ALIAS[arg.replace(/^-+/, "")] ?? arg.replace(/^-+/, "")
      const next = argv[i + 1]
      if (next === undefined || next.startsWith("-")) {
        flags[key] = true
      } else {
        flags[key] = next
        i++
      }
    } else {
      ;(flags._ as string[]).push(arg)
    }
  }
  return flags
}

const HELP = `easycruit-cli — search public EasyCruit career sites from the Trondheim registry

USAGE
  bun run src/cli.ts search [flags]
  bun run src/cli.ts detail <slug/id|url> [--format json|plain]

SEARCH FLAGS
  --query, -q <text>        Keywords matched against title and description.
  --location, -l <text>     Commute area ("area"), a municipality/place
                            (Stjørdal, Trondheim, Heimdal), or any place.
  --jobage <days>           Posted within N days (XML date_start).
  --page <n>                1-indexed result page. Default 1.
  --limit, -n <n>           Results per page / cap. Default 50.
  --detail-limit <n>        Max detail pages fetched per run. Default 40.
  --format <fmt>            json (default) | table | plain.

DETAIL
  <slug/id|url>             e.g. stjordal/3673377 or a full
                            https://stjordal.easycruit.com/vacancy/3673377 URL.
                            A bare vacancy id is rejected: EasyCruit sites do
                            not share an ID namespace, so it cannot be resolved
                            to an employer without guessing.

EXAMPLES
  bun run src/cli.ts search -l area --limit 10 --format table
  bun run src/cli.ts search -q lærer -l Stjørdal --limit 10 --format table
  bun run src/cli.ts search -q bærekraft -l area --format json
  bun run src/cli.ts detail stjordal/3673377 --format plain

Reads enabled rows with ats=easycruit from job_scraper/employers.csv.
`

const KNOWN_FLAGS: Record<string, Set<string>> = {
  search: new Set([
    "query",
    "location",
    "jobage",
    "page",
    "limit",
    "detail-limit",
    "format",
    "help",
    "h",
  ]),
  detail: new Set(["format", "help", "h"]),
}

function fail(error: string, code: string): number {
  process.stderr.write(JSON.stringify({ error, code }) + "\n")
  return 1
}

function intFlag(name: string, raw: string | boolean | string[]): number | null {
  const value = typeof raw === "string" ? Number(raw.trim()) : NaN
  if (!Number.isInteger(value) || value < 1) {
    fail(`--${name} must be a whole number of at least 1, got "${String(raw)}"`, "BAD_ARG")
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

  const known = KNOWN_FLAGS[cmd]
  if (known) {
    for (const key of Object.keys(flags)) {
      if (key === "_" || known.has(key)) continue
      return fail(
        `unknown flag --${key} for '${cmd}' - flags are never silently ignored; see --help`,
        "UNKNOWN_FLAG",
      )
    }
  }

  const fmt = flags.format !== undefined ? String(flags.format) : "json"

  if (cmd === "search") {
    if (!["json", "table", "plain"].includes(fmt)) {
      return fail(`--format must be one of json|table|plain, got "${fmt}"`, "BAD_ARG")
    }
    if (flags.query !== undefined && (typeof flags.query !== "string" || !flags.query.trim())) {
      return fail("--query requires a non-empty value", "BAD_ARG")
    }
    if (flags.location !== undefined && (typeof flags.location !== "string" || !flags.location.trim())) {
      return fail("--location requires a non-empty value", "BAD_ARG")
    }
    let jobage: number | undefined
    if (flags.jobage !== undefined) {
      const value = intFlag("jobage", flags.jobage)
      if (value === null) return 1
      jobage = value
    }
    let page = 1
    if (flags.page !== undefined) {
      const value = intFlag("page", flags.page)
      if (value === null) return 1
      page = value
    }
    let limit: number | undefined
    if (flags.limit !== undefined) {
      const value = intFlag("limit", flags.limit)
      if (value === null) return 1
      limit = value
    }
    let detailLimit: number | undefined
    if (flags["detail-limit"] !== undefined) {
      const value = intFlag("detail-limit", flags["detail-limit"])
      if (value === null) return 1
      detailLimit = value
    }
    const opts: SearchOpts = {
      query: typeof flags.query === "string" ? flags.query : undefined,
      location: typeof flags.location === "string" ? flags.location : undefined,
      jobage,
      page,
      limit,
      detailLimit,
      format: fmt as SearchOpts["format"],
    }
    return runSearch(opts)
  }

  if (cmd === "detail") {
    if (!["json", "plain"].includes(fmt)) {
      return fail(`--format must be one of json|plain, got "${fmt}"`, "BAD_ARG")
    }
    const id = (flags._ as string[])[1]
    if (!id) return fail("detail requires an <slug/id|url>", "NO_ID")
    const opts: DetailOpts = { id, format: fmt as DetailOpts["format"] }
    return runDetail(opts)
  }

  return fail(`Unknown command "${cmd}"`, "BAD_CMD")
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
