import {
  MAX_CONCURRENCY,
  fetchText,
  filterEmployers,
  fold,
  isWithinDays,
  loadArea,
  loadRegistry,
  locationMatches,
  mapLimit,
  matchesQuery,
  normalizeDetailTarget,
  paginate,
  parseAttractDetail,
  parseAttractList,
  parseExtDetail,
  parseExtList,
  resolveSource,
  sortResults,
  stripInvisible,
  writeError,
  type Area,
  type Employer,
  type FetchInit,
  type JobResult,
  type MetaError,
  type ParsedResult,
} from "../helpers.js"

export interface SearchOpts {
  query?: string
  location?: string
  jobage?: number
  page: number
  limit?: number
  /** For list rows with no location, fetch up to N detail pages to find one. */
  locationDetailLimit?: number
  format: "json" | "table" | "plain"
}

export interface SearchDeps {
  employers: Employer[]
  area: Area | null
  fetchText: (url: string, init?: FetchInit) => Promise<string | null>
}

export const defaultDeps = (): SearchDeps => ({
  employers: filterEmployers(loadRegistry(), "reachmee"),
  area: loadArea(),
  fetchText,
})

export async function collectResults(
  opts: SearchOpts,
  deps: SearchDeps = defaultDeps(),
): Promise<{ results: JobResult[]; errors: MetaError[]; warnings: string[] }> {
  if (opts.location && fold(opts.location) === "area" && !deps.area) {
    throw new Error("job_scraper/area.json is missing, so --location area cannot be applied")
  }

  const errors: MetaError[] = []
  const warnings: string[] = []
  const pooled: JobResult[] = []
  // ReachMee list pages often omit location (Asplan's "Sted" column is blank;
  // Sweco's Attract table has no location column at all). When a location
  // filter is requested, defer those rows and read their detail page instead
  // of dropping them as non-matches.
  const unknownLocation: Array<{ employer: Employer; parsed: ParsedResult }> = []

  await mapLimit(deps.employers, MAX_CONCURRENCY, async (employer) => {
    try {
      const source = await resolveSource(employer, deps.fetchText)
      if (!source) {
        errors.push({
          employer: employer.name,
          error:
            "no usable ReachMee list source: ats_ref has no validator and no Attract site or validator-bearing ReachMee link was found (the seed ats_ref may be stale)",
        })
        return
      }

      const html = await deps.fetchText(source.listUrl)
      if (html === null) {
        errors.push({
          employer: employer.name,
          error: `ReachMee list URL returned 404: ${source.listUrl} (the seed ats_ref may be stale, or the customer requires a validator)`,
        })
        return
      }

      const parsedRows: ParsedResult[] =
        source.kind === "attract"
          ? parseAttractList(html, employer.name, source.base)
          : parseExtList(html, employer.name, source.base)

      for (const parsed of parsedRows) {
        if (opts.query && !matchesQuery(opts.query, [parsed.queryText])) continue
        if (opts.jobage !== undefined && !(parsed.result.date && isWithinDays(parsed.result.date, opts.jobage))) continue
        if (opts.location) {
          if (!parsed.locationText) {
            unknownLocation.push({ employer, parsed })
            continue
          }
          if (!locationMatches(parsed.locationText, opts.location, deps.area)) continue
        }
        pooled.push(parsed.result)
      }
    } catch (e) {
      errors.push({ employer: employer.name, error: e instanceof Error ? e.message : String(e) })
    }
  })

  if (opts.location && unknownLocation.length > 0) {
    const cap = opts.locationDetailLimit ?? 200
    if (unknownLocation.length > cap) {
      warnings.push(
        `${unknownLocation.length - cap} listing(s) with no location were not checked because --location-detail-limit=${cap}; raise it to include them.`,
      )
    }
    await mapLimit(unknownLocation.slice(0, cap), MAX_CONCURRENCY, async ({ employer, parsed }) => {
      try {
        const target = normalizeDetailTarget(parsed.result.url)
        if (!target) return
        const html = await deps.fetchText(target.url)
        if (!html) return
        const detail =
          target.kind === "attract"
            ? parseAttractDetail(html, target, employer.name)
            : parseExtDetail(html, target, employer.name)
        if (detail.location && locationMatches(detail.location, opts.location, deps.area)) {
          parsed.result.location = detail.location
          pooled.push(parsed.result)
        }
      } catch {
        // A detail fetch failure just leaves the row out of the location-filtered
        // pool; it is not an employer-level list failure.
      }
    })
  }

  errors.sort((a, b) => a.employer.localeCompare(b.employer))
  return { results: sortResults(pooled), errors, warnings }
}

function displayId(id: string): string {
  if (/^https?:\/\//i.test(id)) {
    const job = id.match(/[?&]job_id=(\d+)/i)?.[1] ?? id.match(/\/jobs\/(\d+)/)?.[1]
    return job ? `job:${job}` : id
  }
  return id
}

function renderTable(results: JobResult[]): string {
  if (results.length === 0) return "No results."
  const rows = results.map((r) => {
    const id = displayId(r.id).slice(0, 13).padEnd(13)
    const title = (r.title || "").slice(0, 40).padEnd(40)
    const company = (r.company || "—").slice(0, 24).padEnd(24)
    const location = (r.location || "—").slice(0, 20).padEnd(20)
    const date = r.date || "—"
    return `${id} ${title} ${company} ${location} ${date}`
  })
  const header =
    "ID".padEnd(13) + " " + "TITLE".padEnd(40) + " " + "COMPANY".padEnd(24) + " " + "LOCATION".padEnd(20) + " DATE"
  return [header, "-".repeat(header.length), ...rows].join("\n")
}

function renderPlain(results: JobResult[]): string {
  if (results.length === 0) return "No results."
  return results
    .map(
      (r) =>
        `${r.title}\n  ${r.company || "—"} · ${r.location || "—"} · ${r.date || "—"}\n  id: ${displayId(r.id)}\n  ${r.url}`,
    )
    .join("\n\n")
}

export async function runSearch(opts: SearchOpts, deps: SearchDeps = defaultDeps()): Promise<number> {
  try {
    const { results, errors, warnings } = await collectResults(opts, deps)
    const emitted = paginate(results, opts.page, opts.limit).map((result) => stripInvisible(result))

    if (opts.format === "table") {
      process.stdout.write(renderTable(emitted) + "\n")
    } else if (opts.format === "plain") {
      process.stdout.write(renderPlain(emitted) + "\n")
    } else {
      process.stdout.write(
        JSON.stringify(
          {
            meta: {
              count: emitted.length,
              page: opts.page,
              errors: stripInvisible(errors),
              ...(warnings.length ? { warning: warnings.join(" ") } : {}),
            },
            results: emitted,
          },
          null,
          2,
        ) + "\n",
      )
    }
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "SEARCH_FAILED")
    return 1
  }
}
