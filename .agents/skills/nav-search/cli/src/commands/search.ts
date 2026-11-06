import { existsSync, statSync } from "node:fs"
import {
  isoDate,
  loadArea,
  loadEmployers,
  matchesLocation,
  normalizeCompany,
  publicAdUrl,
  readCacheFile,
  STILLINGSANNONSE,
  resolvePaths,
  sortRecords,
  stripInvisible,
  withinJobage,
  writeError,
  type EmployerRow,
  type NormRecord,
} from "../helpers.js"
import { performSync } from "./sync.js"

export interface SearchOpts {
  query?: string
  location?: string
  jobage?: number
  page: number
  limit?: number
  maxAgeMinutes: number
  format: "json" | "table" | "plain"
}

interface SearchResult {
  id: string
  title: string | null
  company: string | null
  location: string | null
  date: string | null
  url: string
}

const DEFAULT_LIMIT = 20
const DEFAULT_SYNC_DAYS = 30
const DEFAULT_SYNC_PAGES = 20
const DEFAULT_DETAILS_LIMIT = 15

function toResult(record: NormRecord, employers: EmployerRow[]): SearchResult {
  return {
    id: record.id || record.uuid,
    title: record.title ?? null,
    company: normalizeCompany(record.raw_company ?? record.company, record.orgnr, employers) ?? record.company ?? null,
    location: record.location ?? record.municipal ?? null,
    date: record.date ?? isoDate(record.date_modified),
    url: record.url || publicAdUrl(record.uuid),
  }
}

function renderTable(results: SearchResult[]): string {
  if (results.length === 0) return "No results."
  const rows = results.map((result) => {
    const id = result.id.padEnd(36)
    const title = (result.title ?? "—").slice(0, 40).padEnd(40)
    const company = (result.company ?? "—").slice(0, 28).padEnd(28)
    const location = (result.location ?? "—").slice(0, 22).padEnd(22)
    const date = result.date ?? "—"
    return `${id} ${title} ${company} ${location} ${date}`
  })
  const header =
    "ID".padEnd(36) +
    " " +
    "TITLE".padEnd(40) +
    " " +
    "COMPANY".padEnd(28) +
    " " +
    "LOCATION".padEnd(22) +
    " DATE"
  return [header, "-".repeat(header.length), ...rows].join("\n")
}

export async function runSearch(opts: SearchOpts): Promise<number> {
  try {
    const paths = resolvePaths()
    const token = process.env.NAV_API_TOKEN?.trim()
    const cacheExists = existsSync(paths.cachePath)
    let warning: string | undefined

    let cacheAge = Number.POSITIVE_INFINITY
    if (cacheExists) {
      try {
        cacheAge = Date.now() - statSync(paths.cachePath).mtimeMs
      } catch {
        cacheAge = Number.POSITIVE_INFINITY
      }
    }
    const stale = !cacheExists || cacheAge > opts.maxAgeMinutes * 60000

    if (stale) {
      if (token) {
        try {
          await performSync({
            sinceDays: DEFAULT_SYNC_DAYS,
            maxPages: DEFAULT_SYNC_PAGES,
            detailsLimit: DEFAULT_DETAILS_LIMIT,
            dryRun: false,
            token,
            paths,
          })
        } catch (error) {
          if (!cacheExists) {
            writeError(
              `Could not build a NAV cache and no previous cache exists: ${error instanceof Error ? error.message : String(error)}`,
              "SYNC_FAILED",
            )
            return 1
          }
          warning = `NAV cache refresh failed (${error instanceof Error ? error.message : String(error)}); using the existing cache.`
        }
      } else if (!cacheExists) {
        writeError(
          "No NAV cache found and NAV_API_TOKEN is not set. Export NAV_API_TOKEN (request a private token from nav.team.arbeidsplassen@nav.no) so nav-search can sync the feed, or run `sync` first.",
          "MISSING_CREDENTIALS",
        )
        return 1
      } else {
        warning = `NAV cache is older than ${opts.maxAgeMinutes} minutes and NAV_API_TOKEN is not set; using the stale cache.`
      }
    }

    const records = readCacheFile(paths.cachePath)
    const employers = loadEmployers(paths.employersPath)
    const area = loadArea(paths.areaPath)
    const needle = opts.query?.trim().toLowerCase() || null

    let matches = [...records.values()].filter((record) => {
      if (record.status !== "ACTIVE") return false
      if (needle) {
        const content = record.content_text?.trim()
        const texts = [record.title, record.description]
        if (content && content.toLowerCase() !== STILLINGSANNONSE.toLowerCase()) texts.push(content)
        const haystack = texts.filter((value): value is string => Boolean(value)).join(" ").toLowerCase()
        if (!haystack.includes(needle)) return false
      }
      if (!matchesLocation(record, opts.location, area)) return false
      if (opts.jobage !== undefined && !withinJobage(record, opts.jobage)) return false
      return true
    })

    matches = sortRecords(matches)
    const page = Math.max(1, opts.page)
    const limit = opts.limit ?? DEFAULT_LIMIT
    const from = (page - 1) * limit
    const paged = matches.slice(from, from + limit).map((record) => toResult(record, employers))
    const meta: Record<string, unknown> = { count: paged.length, page }
    if (warning) meta.warning = warning

    const output = stripInvisible({ meta, results: paged })
    if (opts.format === "table") {
      process.stdout.write(renderTable(output.results) + "\n")
    } else if (opts.format === "plain") {
      process.stdout.write(
        output.results
          .map(
            (result) =>
              `${result.title ?? "(untitled)"}\n  ${result.company ?? "—"} · ${result.location ?? "—"} · ${result.date ?? "—"}\n  id: ${result.id}\n  ${result.url}`,
          )
          .join("\n\n") + (output.results.length ? "\n" : "No results.\n"),
      )
    } else {
      process.stdout.write(JSON.stringify(output, null, 2) + "\n")
    }
    return 0
  } catch (error) {
    writeError(error instanceof Error ? error.message : String(error), "SEARCH_FAILED")
    return 1
  }
}
