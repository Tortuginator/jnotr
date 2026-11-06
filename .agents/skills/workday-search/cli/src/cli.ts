#!/usr/bin/env bun
// Search Workday career sites through their public CXS JSON API.
//
// Reads enabled `ats=workday` rows from job_scraper/employers.csv (falling back
// to trondheim-patches/employers.seed.csv), fetches each career site with
// concurrency 4, and filters the pooled postings.
//
// No authentication, no API key, zero runtime dependencies.

import { runSearch, type SearchOpts } from "./commands/search.js"
import { runDetail, type DetailOpts } from "./commands/detail.js"

interface Flags {
  _: string[]
  [k: string]: string | boolean | string[]
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { _: [] }
  const alias: Record<string, string> = { q: "query", l: "location", n: "limit" }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
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
      ;(flags._ as string[]).push(arg)
    }
  }
  return flags
}

const HELP = `workday-search-cli — search Workday career sites (Norway / Trondheim)

USAGE
  bun run src/cli.ts search [flags]
  bun run src/cli.ts detail <id|url> [--format json|plain]

SEARCH FLAGS
  --query, -q <text>          Keywords sent to Workday as searchText.
  --location, -l <text>       "area" for the Trondheim commute area
                              (job_scraper/area.json), a place such as "Trondheim",
                              "Heimdal" or "Stjørdal", or omit for all locations.
  --jobage <days>             Posted within N days (parsed from Workday's relative
                              "Posted N Days Ago" label).
  --page <n>                  1-indexed page; offset = (page - 1) * limit.
  --limit, -n <n>             Workday page size and cap on emitted results (max 100).
  --location-detail-limit <n> Max ambiguous postings whose detail is fetched to
                              verify a location. Default 20.
  --format <fmt>              json (default) | table | plain.

DETAIL
  detail accepts a full Workday posting URL (preferred), a
  <tenant>/<site>/job/... id, or a bare /job/... path when the registry has one
  Workday site.

EXAMPLES
  bun run src/cli.ts search -l area --limit 10 --format table
  bun run src/cli.ts search -q sommerstudent -l area --format json
  bun run src/cli.ts search -q data -l Trondheim --jobage 30 --format table
  bun run src/cli.ts detail "https://norconsult.wd3.myworkdayjobs.com/Norconsult_Career_Site/job/Trondheim/Sommerjobb-2027---Dam-og-vassdrag_REQ-6486" --format plain
`

const KNOWN_FLAGS: Record<string, Set<string>> = {
  search: new Set([
    "query", "location", "jobage", "page", "limit", "format", "location-detail-limit", "help", "h",
  ]),
  detail: new Set(["format", "help", "h"]),
}

function parsePositiveInt(name: string, raw: string | boolean | string[]): number | null {
  const value = typeof raw === "string" ? Number(raw.trim()) : NaN
  if (!Number.isInteger(value) || value < 1) {
    process.stderr.write(
      JSON.stringify({
        error: `--${name} must be a whole number of at least 1, got "${raw}"`,
        code: "BAD_ARG",
      }) + "\n",
    )
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
      process.stderr.write(
        JSON.stringify({
          error: `unknown flag --${key} for '${cmd}'; flags are never silently ignored; see --help for the supported flags`,
          code: "UNKNOWN_FLAG",
        }) + "\n",
      )
      return 1
    }
  }

  if (cmd === "search") {
    if (flags.query !== undefined && (typeof flags.query !== "string" || !flags.query.trim())) {
      process.stderr.write(JSON.stringify({ error: "--query requires a non-empty value", code: "BAD_ARG" }) + "\n")
      return 1
    }
    if (flags.location !== undefined && (typeof flags.location !== "string" || !flags.location.trim())) {
      process.stderr.write(JSON.stringify({ error: "--location requires a non-empty value", code: "BAD_ARG" }) + "\n")
      return 1
    }

    const format = flags.format !== undefined ? String(flags.format) : "json"
    if (!["json", "table", "plain"].includes(format)) {
      process.stderr.write(
        JSON.stringify({ error: `--format must be one of json|table|plain, got "${format}"`, code: "BAD_ARG" }) + "\n",
      )
      return 1
    }

    for (const name of ["jobage", "page", "limit", "location-detail-limit"]) {
      if (flags[name] !== undefined) {
        const value = parsePositiveInt(name, flags[name])
        if (value === null) return 1
        flags[name] = String(value)
      }
    }
    if (flags.limit !== undefined && parseInt(flags.limit as string, 10) > 100) {
      process.stderr.write(
        JSON.stringify({ error: "--limit cannot exceed 100 (Workday's page-size maximum)", code: "BAD_ARG" }) + "\n",
      )
      return 1
    }

    const opts: SearchOpts = {
      query: typeof flags.query === "string" ? flags.query : undefined,
      location: typeof flags.location === "string" ? flags.location : undefined,
      jobage: flags.jobage ? parseInt(flags.jobage as string, 10) : undefined,
      page: flags.page ? parseInt(flags.page as string, 10) : 1,
      limit: flags.limit ? parseInt(flags.limit as string, 10) : undefined,
      locationDetailLimit: flags["location-detail-limit"]
        ? parseInt(flags["location-detail-limit"] as string, 10)
        : undefined,
      format: format as SearchOpts["format"],
    }
    return runSearch(opts)
  }

  if (cmd === "detail") {
    const input = (flags._ as string[])[1]
    if (!input) {
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
    const opts: DetailOpts = { input, format: format as DetailOpts["format"] }
    return runDetail(opts)
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
