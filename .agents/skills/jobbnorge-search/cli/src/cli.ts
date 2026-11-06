#!/usr/bin/env bun
// Self-contained CLI for Jobbnorge, the Norwegian job board used by academia,
// state agencies, hospitals and the public sector. No runtime dependencies.
//
// Data is read from Jobbnorge's public JSON endpoints (search API + the
// language-specific detail endpoints the site's own Angular client calls).
// Keep volume low: this is a personal job-search helper, not a crawler.

import { runSearch, type SearchOpts } from "./commands/search.js"
import { runDetail, type DetailOpts } from "./commands/detail.js"

interface Flags {
  _: string[]
  [k: string]: string | boolean | string[]
}

const ALIASES: Record<string, string> = { q: "query", l: "location", n: "limit", h: "help" }

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { _: [] }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--") {
      ;(flags._ as string[]).push(...argv.slice(i + 1))
      break
    }

    if (arg.startsWith("--") || (arg.startsWith("-") && arg !== "-")) {
      const body = arg.replace(/^-+/, "")
      const eq = body.indexOf("=")
      const rawKey = eq >= 0 ? body.slice(0, eq) : body
      const inlineValue = eq >= 0 ? body.slice(eq + 1) : undefined
      const key = ALIASES[rawKey] ?? rawKey

      if (inlineValue !== undefined) {
        flags[key] = inlineValue
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
        flags[key] = argv[++i]
      } else {
        flags[key] = true
      }
      continue
    }

    ;(flags._ as string[]).push(arg)
  }

  return flags
}

const HELP = `jobbnorge-search-cli — search Jobbnorge (Norway: academia, state, hospitals, public sector)

USAGE
  bun run src/cli.ts search [flags]
  bun run src/cli.ts detail <id|url> [--format json|plain]

SEARCH FLAGS
  --query, -q <text>      Free-text search term (e.g. "rådgiver", "stipendiat", "utvikler").
  --location, -l <place>  "area" (Trondheim commute area: 5001, 5031, 5028, 5029, 5035),
                          a municipality (e.g. Trondheim, Stjørdal), a county
                          (e.g. Trøndelag), or a numeric code. Omit for nationwide.
  --jobage <days>         Posted within N days. Jobbnorge only exposes 1-day and
                          7-day windows: 1 = Day, 2+ = Week (reported in meta.note).
  --page <n>              1-indexed page. Default 1.
  --limit, -n <n>         Cap emitted results (client-side).
  --format <fmt>          json (default) | table | plain.

DETAIL FLAGS
  --format <fmt>          json (default) | plain.

EXAMPLES
  bun run src/cli.ts search -q "rådgiver" -l area --limit 5 --format table
  bun run src/cli.ts search -q "stipendiat" -l Trondheim --format table
  bun run src/cli.ts search -q "utvikler" -l Trøndelag --jobage 7 --format table
  bun run src/cli.ts search -q "professor" --format json
  bun run src/cli.ts detail 310059 --format plain
  bun run src/cli.ts detail "https://www.jobbnorge.no/ledige-stillinger/stilling/310059" --format json

Data source: publicapi.jobbnorge.no (search, counties) and id.jobbnorge.no
(detail content). Public, no token. Keep volume low.
`

const KNOWN_FLAGS: Record<string, Set<string>> = {
  search: new Set(["query", "location", "jobage", "page", "limit", "format", "help"]),
  detail: new Set(["format", "help"]),
}

function badArg(message: string): number {
  process.stderr.write(JSON.stringify({ error: message, code: "BAD_ARG" }) + "\n")
  return 1
}

function parseIntFlag(name: string, raw: string | boolean | string[]): number | null {
  const value = typeof raw === "string" ? Number(raw.trim()) : NaN
  if (!Number.isInteger(value) || value < 1) return null
  return value
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const flags = parseFlags(argv)
  const cmd = (flags._ as string[])[0]

  if (!cmd || flags.help) {
    process.stdout.write(HELP)
    return cmd ? 0 : 1
  }

  const knownFlags = KNOWN_FLAGS[cmd]
  if (knownFlags) {
    for (const key of Object.keys(flags)) {
      if (key === "_" || knownFlags.has(key)) continue
      process.stderr.write(
        JSON.stringify({
          error: `unknown flag --${key} for '${cmd}' - flags are never silently ignored, because a discarded filter changes what the search returns; see --help for the supported flags`,
          code: "UNKNOWN_FLAG",
        }) + "\n",
      )
      return 1
    }
  }

  if (cmd === "search") {
    if (flags.query !== undefined && (typeof flags.query !== "string" || !flags.query.trim())) {
      return badArg("--query requires a non-empty value")
    }
    if (flags.location !== undefined && (typeof flags.location !== "string" || !flags.location.trim())) {
      return badArg("--location requires a non-empty value")
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
      if (value === null) return badArg(`--jobage must be a whole number of at least 1, got "${flags.jobage}"`)
      jobage = value
    }
    if (flags.page !== undefined) {
      const value = parseIntFlag("page", flags.page)
      if (value === null) return badArg(`--page must be a whole number of at least 1, got "${flags.page}"`)
      page = value
    }
    if (flags.limit !== undefined) {
      const value = parseIntFlag("limit", flags.limit)
      if (value === null) return badArg(`--limit must be a whole number of at least 1, got "${flags.limit}"`)
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
    if (!id) {
      process.stderr.write(JSON.stringify({ error: "detail requires an <id|url>", code: "NO_ID" }) + "\n")
      return 1
    }

    const fmt = flags.format !== undefined ? String(flags.format) : "json"
    if (!["json", "plain"].includes(fmt)) {
      return badArg(`--format must be one of json|plain, got "${fmt}"`)
    }

    const opts: DetailOpts = { id, format: fmt as DetailOpts["format"] }
    return runDetail(opts)
  }

  process.stderr.write(JSON.stringify({ error: `Unknown command "${cmd}"`, code: "BAD_CMD" }) + "\n")
  return 1
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
