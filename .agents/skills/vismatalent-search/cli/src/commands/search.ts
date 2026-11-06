import {
  DEFAULT_LIMIT,
  MAX_CONCURRENCY,
  MissingRegistryError,
  fetchJobs,
  fetchText,
  filterEmployers,
  fold,
  isWithinDays,
  loadArea,
  loadRegistry,
  locationMatches,
  mapLimit,
  matchesQuery,
  paginate,
  parseJob,
  resolveSiteGuid,
  sortResults,
  stripInvisible,
  writeError,
  type Area,
  type Employer,
  type FetchInit,
  type JobResult,
  type MetaError,
} from "../helpers.js"

export interface SearchOpts {
  query?: string
  location?: string
  jobage?: number
  page: number
  limit?: number
  format: "json" | "table" | "plain"
  now?: Date
}

export interface SearchDeps {
  employers: Employer[] | null
  area: Area | null
  fetchText: (url: string, init?: FetchInit) => Promise<string | null>
}

export const defaultDeps = (): SearchDeps => {
  const rows = loadRegistry()
  return {
    employers: rows === null ? null : filterEmployers(rows, "vismatalent"),
    area: loadArea(),
    fetchText,
  }
}

export interface CollectResult {
  results: JobResult[]
  errors: MetaError[]
}

export async function collectResults(opts: SearchOpts, deps: SearchDeps = defaultDeps()): Promise<CollectResult> {
  if (deps.employers === null) throw new MissingRegistryError()
  if (opts.location && fold(opts.location) === "area" && !deps.area) {
    throw new Error("job_scraper/area.json is missing, so --location area cannot be applied")
  }

  const errors: MetaError[] = []
  const pooled: JobResult[] = []

  await mapLimit(deps.employers, MAX_CONCURRENCY, async (employer) => {
    try {
      const siteGuid = resolveSiteGuid(employer.atsRef)
      if (!siteGuid) {
        errors.push({
          employer: employer.name,
          error:
            "no siteGuid in ats_ref (expected a hire.vismatalent.com careers URL ending in a GUID, or a bare GUID)",
        })
        return
      }

      const jobs = await fetchJobs(siteGuid, deps.fetchText)
      for (const job of jobs) {
        const parsed = parseJob(job, siteGuid, employer.name)
        if (!parsed) continue
        if (opts.query && !matchesQuery(opts.query, [parsed.queryText])) continue
        if (opts.location && !locationMatches(parsed.locationText, opts.location, deps.area)) continue
        if (
          opts.jobage !== undefined &&
          !(parsed.result.date && isWithinDays(parsed.result.date, opts.jobage, opts.now))
        ) {
          continue
        }
        pooled.push(parsed.result)
      }
    } catch (e) {
      errors.push({ employer: employer.name, error: e instanceof Error ? e.message : String(e) })
    }
  })

  errors.sort((a, b) => a.employer.localeCompare(b.employer))
  return { results: sortResults(pooled), errors }
}

export interface SearchResponse {
  meta: { count: number; page: number; errors: MetaError[] }
  results: JobResult[]
}

export function buildSearchResponse(results: JobResult[], page: number, errors: MetaError[]): SearchResponse {
  return {
    meta: { count: results.length, page, errors: stripInvisible(errors) },
    results: stripInvisible(results),
  }
}

function renderTable(results: JobResult[]): string {
  if (results.length === 0) return "No results."
  const rows = results.map((r) => {
    const title = (r.title || "").slice(0, 36).padEnd(36)
    const company = (r.company || "—").slice(0, 22).padEnd(22)
    const location = (r.location || "—").slice(0, 20).padEnd(20)
    const date = r.date || "—"
    return `${r.id.padEnd(75)} ${title} ${company} ${location} ${date}`
  })
  const header =
    "ID".padEnd(75) + " " + "TITLE".padEnd(36) + " " + "COMPANY".padEnd(22) + " " + "LOCATION".padEnd(20) + " DATE"
  return [header, "-".repeat(header.length), ...rows].join("\n")
}

function renderPlain(results: JobResult[]): string {
  if (results.length === 0) return "No results."
  return results
    .map(
      (r) =>
        `${r.title}\n  ${r.company || "—"} · ${r.location || "—"} · ${r.date || "—"}\n  id: ${r.id}\n  ${r.url}`,
    )
    .join("\n\n")
}

export async function runSearch(opts: SearchOpts, deps: SearchDeps = defaultDeps()): Promise<number> {
  try {
    const { results, errors } = await collectResults(opts, deps)
    const emitted = paginate(results, opts.page, opts.limit ?? DEFAULT_LIMIT).map((result) => stripInvisible(result))

    if (opts.format === "table") {
      process.stdout.write(renderTable(emitted) + "\n")
    } else if (opts.format === "plain") {
      process.stdout.write(renderPlain(emitted) + "\n")
    } else {
      process.stdout.write(JSON.stringify(buildSearchResponse(emitted, opts.page, errors), null, 2) + "\n")
    }
    return 0
  } catch (e) {
    if (e instanceof MissingRegistryError) {
      writeError(e.message, "NO_REGISTRY")
    } else {
      writeError(e instanceof Error ? e.message : String(e), "SEARCH_FAILED")
    }
    return 1
  }
}
