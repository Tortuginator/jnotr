import {
  API_BASE,
  LocationError,
  dedupeById,
  fetchCounties,
  jsonFetch,
  loadAreaFile,
  loadEmployerIndex,
  locationMatchesNames,
  locationNamesForFilter,
  parseSearchResults,
  resolveLocation,
  stripInvisible,
  writeError,
  type County,
  type LocationFilter,
  type RawJob,
} from "../helpers.js"

export interface SearchOpts {
  query?: string
  location?: string
  jobage?: number
  page: number
  limit?: number
  format: "json" | "table" | "plain"
}

export interface PeriodFilter {
  period: "Day" | "Week" | null
  note?: string
}

/**
 * Jobbnorge's public API exposes only Period=Day (1 day) and Period=Week
 * (7 days); there is no publication date in the search payload to filter on
 * client-side. --jobage 1 maps to Day and every larger value maps to Week, the
 * closest bounded window. The approximation is reported in meta.note so it is
 * not silent.
 */
export function periodForJobage(jobage: number | undefined): PeriodFilter {
  if (jobage === undefined) return { period: null }
  if (jobage <= 1) return { period: "Day" }
  return {
    period: "Week",
    note: `Jobbnorge exposes only 1-day and 7-day publication windows; --jobage ${jobage} uses the 7-day window.`,
  }
}

export function requestSize(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? 50, 1), 100)
}

export function buildSearchUrl(opts: SearchOpts, filter: LocationFilter): string {
  const params = new URLSearchParams()
  if (opts.query) params.set("term", opts.query)
  for (const id of filter.municipalities) params.append("municipality", String(id))
  for (const id of filter.counties) params.append("county", String(id))
  const { period } = periodForJobage(opts.jobage)
  if (period) params.set("period", period)
  params.set("orderby", "Published")
  // The public API's page parameter is 0-indexed (verified live: page=0 with
  // results=5 returns the first five; page=1 returns the sixth). The CLI keeps
  // the contract's 1-indexed --page.
  params.set("page", String(Math.max(0, opts.page - 1)))
  params.set("results", String(requestSize(opts.limit)))
  return `${API_BASE}/v1/Jobs?${params.toString()}`
}

function renderTable(results: ReturnType<typeof parseSearchResults>): string {
  if (results.length === 0) return "No results."
  const rows = results.map((r) => {
    const title = (r.title || "").slice(0, 44).padEnd(44)
    const company = (r.company || "\u2014").slice(0, 28).padEnd(28)
    const location = (r.location || "\u2014").slice(0, 20).padEnd(20)
    const deadline = r.deadline || "\u2014"
    return `${r.id.padEnd(8)} ${title} ${company} ${location} ${deadline}`
  })
  const header =
    "ID".padEnd(8) + " " + "TITLE".padEnd(44) + " " + "COMPANY".padEnd(28) + " " + "LOCATION".padEnd(20) + " DEADLINE"
  return [header, "-".repeat(header.length), ...rows].join("\n")
}

function renderPlain(results: ReturnType<typeof parseSearchResults>): string {
  return results
    .map((r) =>
      [
        r.title,
        `  ${r.company || "\u2014"} \u00b7 ${r.location || "\u2014"}${r.deadline ? ` \u00b7 deadline ${r.deadline}` : ""}`,
        r.jobScope || r.jobDuration ? `  ${[r.jobScope, r.jobDuration].filter(Boolean).join(" / ")}` : "",
        `  id: ${r.id}`,
        `  ${r.url}`,
        r.summary ? `  ${r.summary}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n")
}

export async function runSearch(opts: SearchOpts): Promise<number> {
  let filter: LocationFilter = { municipalities: [], counties: [], label: "Norway" }
  let counties: County[] = []
  let locationFiltered = false

  try {
    if (opts.location) {
      counties = await fetchCounties()
      filter = resolveLocation(opts.location, counties)
      locationFiltered = true
    }
  } catch (e) {
    if (e instanceof LocationError) {
      writeError(e.message, "BAD_LOCATION")
    } else {
      writeError(e instanceof Error ? e.message : String(e), "SEARCH_FAILED")
    }
    return 1
  }

  try {
    const raw = await jsonFetch<RawJob[]>(buildSearchUrl(opts, filter))
    if (!raw) {
      writeError("Jobbnorge search returned 404", "SEARCH_FAILED")
      return 1
    }
    if (!Array.isArray(raw)) {
      writeError("Jobbnorge search returned an unexpected payload", "SEARCH_FAILED")
      return 1
    }

    const employers = loadEmployerIndex()
    let results = parseSearchResults(dedupeById(raw), employers)

    // The API's municipality/county filter is not reliable for every record
    // (it has returned Bodø and generic "Flere" rows for Trondheim queries).
    // Post-filter on the result's own location before applying --limit.
    let locationNote: string | undefined
    if (locationFiltered) {
      const names = locationNamesForFilter(filter, counties, loadAreaFile())
      const before = results.length
      results = results.filter((result) => locationMatchesNames(result.location, names))
      const dropped = before - results.length
      if (dropped > 0) {
        locationNote = `${dropped} result(s) excluded because their location did not match --location; generic "Flere" locations are excluded.`
      }
    }
    if (opts.limit !== undefined) results = results.slice(0, opts.limit)

    const { period, note } = periodForJobage(opts.jobage)
    const combinedNote = [note, locationNote].filter(Boolean).join(" ")
    const output = stripInvisible({
      meta: {
        count: results.length,
        page: opts.page,
        ...(period ? { period } : {}),
        ...(combinedNote ? { note: combinedNote } : {}),
      },
      results,
    })

    if (opts.format === "table") {
      process.stdout.write(renderTable(output.results) + "\n")
    } else if (opts.format === "plain") {
      process.stdout.write(renderPlain(output.results) + "\n")
    } else {
      process.stdout.write(JSON.stringify(output, null, 2) + "\n")
    }
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "SEARCH_FAILED")
    return 1
  }
}
