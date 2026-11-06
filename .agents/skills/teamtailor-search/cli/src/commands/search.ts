import {
  PER_PAGE,
  cleanInline,
  fetchFeedPage,
  formatLocations,
  htmlToText,
  isWithinDays,
  lastPathSegment,
  loadArea,
  loadRegistry,
  matchesArea,
  matchesPlace,
  normalizeLocation,
  stripInvisible,
  toIsoDate,
  writeError,
  type Employer,
  type FeedItem,
  type RegistryError,
} from "../helpers.js"

export interface SearchOpts {
  query?: string
  location?: string
  jobage?: number
  page: number
  limit?: number
  format: "json" | "table" | "plain"
}

export interface SearchResult {
  id: string | null
  title: string | null
  company: string | null
  location: string | null
  date: string | null
  url: string | null
}

interface EmployerFeed {
  employer: Employer
  items: FeedItem[]
  error: string | null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function fetchEmployerFeed(employer: Employer, pages: number): Promise<EmployerFeed> {
  const items: FeedItem[] = []
  for (let page = 0; page < pages; page++) {
    try {
      const result = await fetchFeedPage(employer.feedUrl, page * PER_PAGE)
      items.push(...result.items)
      if (result.exhausted) break
    } catch (error) {
      return { employer, items, error: errorMessage(error) }
    }
  }
  return { employer, items, error: null }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++
      if (index >= items.length) return
      results[index] = await fn(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

function matchesQuery(item: FeedItem, query: string): boolean {
  const wanted = normalizeLocation(query)
  if (!wanted) return true
  const haystack = normalizeLocation(`${item.title ?? ""} ${htmlToText(item.description) ?? ""}`)
  return haystack.includes(wanted)
}

function toResult(item: FeedItem, employer: Employer): SearchResult {
  return {
    id: item.guid || lastPathSegment(item.link),
    title: cleanInline(item.title),
    company: employer.name,
    location: formatLocations(item.locations),
    date: toIsoDate(item.pubDate),
    url: item.link,
  }
}

function renderTable(results: SearchResult[]): string {
  if (results.length === 0) return "No results."
  const rows = results.map((result) => {
    const id = (result.id || "—").slice(0, 22).padEnd(22)
    const title = (result.title || "—").slice(0, 42).padEnd(42)
    const company = (result.company || "—").slice(0, 26).padEnd(26)
    const location = (result.location || "—").slice(0, 32).padEnd(32)
    const date = result.date || "—"
    return `${id} ${title} ${company} ${location} ${date}`
  })
  const header =
    "ID".padEnd(22) +
    " " +
    "TITLE".padEnd(42) +
    " " +
    "COMPANY".padEnd(26) +
    " " +
    "LOCATION".padEnd(32) +
    " DATE"
  return [header, "-".repeat(header.length), ...rows].join("\n")
}

function renderPlain(results: SearchResult[]): string {
  if (results.length === 0) return "No results."
  return results
    .map((result) =>
      [
        result.title || "(untitled)",
        `  ${result.company || "—"} · ${result.location || "—"} · ${result.date || "—"}`,
        `  id: ${result.id || "—"}`,
        `  ${result.url || "—"}`,
      ].join("\n"),
    )
    .join("\n\n")
}

export async function runSearch(opts: SearchOpts): Promise<number> {
  try {
    const registry = loadRegistry()
    if (!registry) {
      writeError(
        "No employer registry found. Expected job_scraper/employers.csv (or trondheim-patches/employers.seed.csv); run tools/employer_registry.py or copy the seed registry.",
        "NO_REGISTRY",
      )
      return 1
    }

    const location = opts.location?.trim()
    const areaMode = location ? normalizeLocation(location) === "area" : false
    const area = areaMode ? loadArea() : null
    if (areaMode && !area) {
      writeError("Location 'area' needs job_scraper/area.json; the file was not found or is invalid.", "NO_AREA")
      return 1
    }

    const pages = Math.max(1, opts.page)
    const feeds = await mapLimit(registry.employers, 4, (employer) => fetchEmployerFeed(employer, pages))

    const errors: RegistryError[] = [...registry.errors]
    for (const feed of feeds) {
      if (feed.error) errors.push({ employer: feed.employer.name, error: feed.error })
    }

    const results: SearchResult[] = []
    for (const feed of feeds) {
      for (const item of feed.items) {
        if (opts.query && !matchesQuery(item, opts.query)) continue
        if (opts.jobage !== undefined && !isWithinDays(item.pubDate, opts.jobage)) continue
        if (location) {
          if (areaMode && area) {
            if (!matchesArea(item.locations, area)) continue
          } else if (!matchesPlace(item.locations, location)) {
            continue
          }
        }
        const result = toResult(item, feed.employer)
        if (!result.id && !result.url) continue
        results.push(result)
      }
    }

    results.sort((a, b) => {
      if (a.date && b.date && a.date !== b.date) return b.date.localeCompare(a.date)
      if (a.date && !b.date) return -1
      if (!a.date && b.date) return 1
      return (a.company ?? "").localeCompare(b.company ?? "") || (a.title ?? "").localeCompare(b.title ?? "")
    })

    // A feed shared by two registry rows (e.g. two ECURA entities) returns the
    // same posting twice; URL is the cross-source dedup key, so keep the first.
    const seen = new Set<string>()
    const deduped: SearchResult[] = []
    for (const result of results) {
      const key = (result.url || `id:${result.id}`).toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      deduped.push(result)
    }

    const emitted = opts.limit !== undefined ? deduped.slice(0, opts.limit) : deduped
    const clean = stripInvisible(emitted)

    if (opts.format === "table") {
      process.stdout.write(renderTable(clean) + "\n")
    } else if (opts.format === "plain") {
      process.stdout.write(renderPlain(clean) + "\n")
    } else {
      process.stdout.write(
        JSON.stringify(
          { meta: { count: clean.length, page: opts.page, errors: stripInvisible(errors) }, results: clean },
          null,
          2,
        ) + "\n",
      )
    }
    return 0
  } catch (error) {
    writeError(errorMessage(error), "SEARCH_FAILED")
    return 1
  }
}
