#!/usr/bin/env bun
// Search Teamtailor-powered career sites through their public RSS feeds.
//
// Reads the employer registry at job_scraper/employers.csv (falling back to
// trondheim-patches/employers.seed.csv), fetches every enabled Teamtailor feed
// with concurrency 4, and filters the pooled postings client-side.

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

const HELP = `teamtailor-cli — search Teamtailor-powered career sites (Norway / Trondheim)

USAGE
  bun run src/cli.ts search [flags]
  bun run src/cli.ts detail <id|url> [--format json|plain]

SEARCH FLAGS
  --query, -q <text>      Keywords matched case-insensitively on title + description.
  --location, -l <text>   "area" (Trondheim commute area from job_scraper/area.json),
                          a place such as "Trondheim" or "Oslo" (matches location name
                          or city), or omit for all locations.
  --jobage <days>         Posted within N days, from the feed's pubDate.
  --page <n>              Feed pages to read per employer (100 items/page). Default 1.
  --limit, -n <n>         Cap results emitted after filtering.
  --format <fmt>          json (default) | table | plain.

DETAIL
  detail accepts a full posting URL (preferred) or a bare id. A bare id can only
  be resolved when the registry has exactly one Teamtailor employer.

EXAMPLES
  bun run src/cli.ts search -l area --limit 10 --format table
  bun run src/cli.ts search -q engineer -l area --jobage 30 --format table
  bun run src/cli.ts search -q "prosjektleder" -l Trondheim --format json
  bun run src/cli.ts detail "https://karriere.hent.no/jobs/8630421-anleggsleder-betong" --format plain
`

const KNOWN_FLAGS: Record<string, Set<string>> = {
  search: new Set(["query", "location", "jobage", "page", "limit", "format", "help", "h"]),
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
          error: `unknown flag --${key} for '${cmd}'; see --help for the supported flags`,
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

    if (flags.jobage !== undefined) {
      const value = parsePositiveInt("jobage", flags.jobage)
      if (value === null) return 1
      flags.jobage = String(value)
    }
    if (flags.page !== undefined) {
      const value = parsePositiveInt("page", flags.page)
      if (value === null) return 1
      flags.page = String(value)
    }
    if (flags.limit !== undefined) {
      const value = parsePositiveInt("limit", flags.limit)
      if (value === null) return 1
      flags.limit = String(value)
    }

    const opts: SearchOpts = {
      query: typeof flags.query === "string" ? flags.query : undefined,
      location: typeof flags.location === "string" ? flags.location : undefined,
      jobage: flags.jobage ? parseInt(flags.jobage as string, 10) : undefined,
      page: flags.page ? parseInt(flags.page as string, 10) : 1,
      limit: flags.limit ? parseInt(flags.limit as string, 10) : undefined,
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
