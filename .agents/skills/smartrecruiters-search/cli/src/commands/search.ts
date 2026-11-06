import {
  PAGE_SIZE,
  apiGetJson,
  enabledEmployers,
  loadArea,
  locationMatches,
  mapPosting,
  paginate,
  postingsUrl,
  resolveSlug,
  stripInvisible,
  withinJobAge,
  writeError,
  type Area,
  type Employer,
  type FetchLike,
  type JobResult,
  type LocationMapped,
  type SRPostingsResponse,
} from "../helpers.js"

export interface SearchOpts {
  query?: string
  location?: string
  jobage?: number
  page: number
  limit?: number
  format: "json" | "table" | "plain"
}

export interface MetaError {
  employer: string
  error: string
}

export interface SearchDeps {
  fetchImpl?: FetchLike
}

export interface SearchOutcome {
  results: JobResult[]
  errors: MetaError[]
  totalMatched: number
}

const CONCURRENCY = 4

/** Fetch every page for one employer, applying location and age filters. */
export async function fetchEmployer(
  employer: Employer,
  opts: SearchOpts,
  area: Area,
  fetchImpl: FetchLike = fetch,
): Promise<LocationMapped[]> {
  const slug = resolveSlug(employer)
  // All registry employers are Norwegian, so a location filter also constrains
  // the API-side country. This keeps paging small for group-wide accounts.
  const country = opts.location ? "no" : undefined
  const mapped: LocationMapped[] = []
  let offset = 0

  // Hard ceiling so a broken totalFound can never loop forever.
  for (let guard = 0; guard < 100; guard++) {
    const page = await apiGetJson<SRPostingsResponse>(
      postingsUrl(slug, offset, PAGE_SIZE, opts.query, country),
      fetchImpl,
    )
    if (!page) throw new Error(`postings endpoint returned 404 for slug "${slug}"`)
    const items = Array.isArray(page.content) ? page.content : []
    for (const item of items) {
      const entry = mapPosting(item, employer, slug)
      if (!locationMatches(entry.loc, opts.location, area)) continue
      if (!withinJobAge(entry.result.date, opts.jobage)) continue
      mapped.push(entry)
    }
    offset += items.length
    if (items.length === 0 || offset >= page.totalFound) break
  }
  return mapped
}

async function pool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: unknown }>> {
  const out: Array<{ ok: true; value: R } | { ok: false; error: unknown }> = new Array(items.length)
  let next = 0
  async function run(): Promise<void> {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      try {
        out[i] = { ok: true, value: await worker(items[i]) }
      } catch (error) {
        out[i] = { ok: false, error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()))
  return out
}

/** Pool all enabled registry employers, keeping per-employer failures non-fatal. */
export async function searchAll(opts: SearchOpts, deps: SearchDeps = {}): Promise<SearchOutcome> {
  const employers = enabledEmployers("smartrecruiters")
  const area = loadArea() // fail fast on a missing/invalid area file
  const fetchImpl = deps.fetchImpl ?? fetch

  const settled = await pool(employers, CONCURRENCY, (employer) => fetchEmployer(employer, opts, area, fetchImpl))

  const errors: MetaError[] = []
  const byId = new Map<string, LocationMapped>()
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i]
    if (!outcome.ok) {
      errors.push({
        employer: employers[i].name,
        error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
      })
      continue
    }
    for (const entry of outcome.value) {
      // Company+id is unique across employers; URL alone is enough and is what
      // downstream dedup keys on.
      if (!byId.has(entry.result.url)) byId.set(entry.result.url, entry)
    }
  }

  const all = [...byId.values()].sort((a, b) => (b.result.date ?? "").localeCompare(a.result.date ?? ""))
  const results = paginate(
    all.map((entry) => entry.result),
    opts.page,
    opts.limit,
  )
  return { results, errors, totalMatched: all.length }
}

function renderTable(results: JobResult[]): string {
  if (results.length === 0) return "No results."
  const rows = results.map((r) => {
    const title = (r.title || "").slice(0, 42).padEnd(42)
    const company = (r.company || "—").slice(0, 26).padEnd(26)
    const loc = (r.location || "—").slice(0, 28).padEnd(28)
    return `${r.id.padEnd(18)} ${title} ${company} ${loc} ${r.date || "—"}`
  })
  const header =
    "ID".padEnd(18) + " " + "TITLE".padEnd(42) + " " + "COMPANY".padEnd(26) + " " + "LOCATION".padEnd(28) + " DATE"
  return [header, "-".repeat(header.length), ...rows].join("\n")
}

export async function runSearch(opts: SearchOpts, deps: SearchDeps = {}): Promise<number> {
  try {
    const outcome = await searchAll(opts, deps)
    const results = stripInvisible(outcome.results)
    if (opts.format === "table") {
      process.stdout.write(renderTable(results) + "\n")
      if (outcome.errors.length > 0) {
        process.stdout.write(`\n(${outcome.errors.length} employer(s) failed; use --format json for meta.errors)\n`)
      }
    } else if (opts.format === "plain") {
      process.stdout.write(
        results
          .map(
            (r) =>
              `${r.title}\n  ${r.company || "—"} · ${r.location || "—"} · ${r.date || "—"}\n  id: ${r.id}\n  ${r.url}`,
          )
          .join("\n\n") + "\n",
      )
      if (outcome.errors.length > 0) {
        process.stdout.write(`\n(${outcome.errors.length} employer(s) failed; use --format json for meta.errors)\n`)
      }
    } else {
      process.stdout.write(
        JSON.stringify(
          stripInvisible({
            meta: {
              count: results.length,
              page: opts.page,
              totalMatched: outcome.totalMatched,
              errors: outcome.errors,
            },
            results,
          }),
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
