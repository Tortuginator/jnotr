#!/usr/bin/env bun
// Self-contained CLI for reading HR Manager / Talentech job portals used by
// employers in the Trondheim registry. No credentials, zero runtime dependencies.

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
    const a = argv[i]
    if (a.startsWith("-")) {
      const key = ALIAS[a.replace(/^-+/, "")] ?? a.replace(/^-+/, "")
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

const HELP = `hrmanager-cli — search HR Manager / Talentech employers from the Trondheim registry

USAGE
  bun run src/cli.ts search [flags]
  bun run src/cli.ts detail <id|url> [--format json|plain]

SEARCH FLAGS
  --query, -q <text>      Keywords matched on title and description (client-side).
  --location, -l <text>   Commute area ("area"), a municipality/place
                          (Trondheim, Malvik, Heimdal), or a city. Omit = no filter.
  --jobage <days>         Posted within N days (client-side, on pubDate).
  --page <n>              1-indexed result page. Default 1.
  --limit, -n <n>         Results per page / cap. Default 50.
  --format <fmt>          json (default) | table | plain.

DETAIL
  <id|url>                An ApplicationInit.aspx URL, a search result id,
                          or <customer>:<id>.

EXAMPLES
  bun run src/cli.ts search -l area --limit 10 --format table
  bun run src/cli.ts search -q utvikler -l area --jobage 30 --format table
  bun run src/cli.ts search -q rådgiver --format table
  bun run src/cli.ts detail "https://candidate.hr-manager.net/ApplicationInit.aspx?cid=1889&ProjectId=149231" --format plain

Reads enabled rows with ats=hrmanager from job_scraper/employers.csv.
Resolves cid=<n> rows through the public RSS endpoint; never guesses a customer.
`

const KNOWN_FLAGS: Record<string, Set<string>> = {
  search: new Set(["query", "location", "jobage", "page", "limit", "format", "help", "h"]),
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
      const v = intFlag("jobage", flags.jobage)
      if (v === null) return 1
      jobage = v
    }
    let page = 1
    if (flags.page !== undefined) {
      const v = intFlag("page", flags.page)
      if (v === null) return 1
      page = v
    }
    let limit: number | undefined
    if (flags.limit !== undefined) {
      const v = intFlag("limit", flags.limit)
      if (v === null) return 1
      limit = v
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
    if (!["json", "plain"].includes(fmt)) {
      return fail(`--format must be one of json|plain, got "${fmt}"`, "BAD_ARG")
    }
    const id = (flags._ as string[])[1]
    if (!id) return fail("detail requires an <id|url>", "NO_ID")
    const opts: DetailOpts = { id, format: fmt as DetailOpts["format"] }
    return runDetail(opts)
  }

  return fail(`Unknown command "${cmd}"`, "BAD_CMD")
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stderr.write(JSON.stringify({ error: e instanceof Error ? e.message : String(e), code: "INTERNAL_ERROR" }) + "\n")
    process.exit(1)
  })
