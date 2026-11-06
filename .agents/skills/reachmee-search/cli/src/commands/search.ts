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
  type ReachSource,
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

/**
 * Identity of a ReachMee source. Several registry rows can point at the same
 * customer through different list URLs (different site/validator query
 * strings), so fetch by customer/base rather than by exact listUrl.
 */
export function reachSourceIdentity(source: ReachSource): string {
  const base = source.base.toLowerCase().replace(/\/+$/, "")
  if (source.kind === "ext" && source.code && source.customer) {
    return `ext:${base}:${source.code.toUpperCase()}:${source.customer}`
  }
  return `${source.kind}:${base}`
}

/**
 * Canonical identity of a posting, used to keep one row per posting when two
 * registry rows share a customer. Legacy ext URLs carry the posting id in
 * `job_id`; Attract URLs carry it in the path.
 */
export function canonicalResultKey(result: JobResult): string {
  const raw = (result.url ?? "").trim()
  if (raw) {
    try {
      const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
      const host = parsed.hostname.toLowerCase()
      const ext = parsed.pathname.match(/^\/ext\/(I\d+)\/(\d+)\/(?:job|main)/i)
      if (/^web\d+\.reachmee\.com$/.test(host) && ext) {
        const jobId = parsed.searchParams.get("job_id")
        if (jobId) return `reachmee:ext:${ext[1].toUpperCase()}:${ext[2]}:job:${jobId}`
        return `reachmee:url:${host}${parsed.pathname.replace(/\/+$/, "")}${parsed.search}`
      }
      if (/\.attract\.reachmee\.com$/i.test(host)) {
        return `reachmee:attract:${host}${parsed.pathname.replace(/\/+$/, "").toLowerCase()}`
      }
      return `url:${host}${parsed.pathname.replace(/\/+$/, "")}${parsed.search}`
    } catch {
      // Not a URL; fall through to the id.
    }
  }
  const id = (result.id ?? "").trim()
  return id ? `id:${id.toLowerCase()}` : `url:${raw.toLowerCase()}`
}

interface SourceGroup {
  key: string
  source: ReachSource
  employers: Employer[]
}

interface GroupRows {
  known: ParsedResult[]
  unknown: ParsedResult[]
}

export async function collectResults(
  opts: SearchOpts,
  deps: SearchDeps = defaultDeps(),
): Promise<{ results: JobResult[]; errors: MetaError[]; warnings: string[] }> {
  if (opts.location && fold(opts.location) === "area" && !deps.area) {
    throw new Error("job_scraper/area.json is missing, so --location area cannot be applied")
  }

  const errors: MetaError[] = []
  const warnings: string[] = []

  const resolved: Array<{ employer: Employer; source: ReachSource } | null> = deps.employers.map(() => null)
  await mapLimit(
    deps.employers.map((employer, index) => ({ employer, index })),
    MAX_CONCURRENCY,
    async ({ employer, index }) => {
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
        resolved[index] = { employer, source }
      } catch (e) {
        errors.push({ employer: employer.name, error: e instanceof Error ? e.message : String(e) })
      }
    },
  )

  // Group in registry order so the first enabled row owns the shared customer
  // and supplies the fetched list URL and company attribution.
  const groups: SourceGroup[] = []
  const byKey = new Map<string, SourceGroup>()
  for (const entry of resolved) {
    if (!entry) continue
    const key = reachSourceIdentity(entry.source)
    let group = byKey.get(key)
    if (!group) {
      group = { key, source: entry.source, employers: [] }
      byKey.set(key, group)
      groups.push(group)
    }
    group.employers.push(entry.employer)
  }

  const groupRows: GroupRows[] = groups.map(() => ({ known: [], unknown: [] }))

  await mapLimit(groups, MAX_CONCURRENCY, async (group) => {
    const slot = groupRows[groups.indexOf(group)]
    try {
      const html = await deps.fetchText(group.source.listUrl)
      if (html === null) {
        for (const employer of group.employers) {
          errors.push({
            employer: employer.name,
            error: `ReachMee list URL returned 404: ${group.source.listUrl} (the seed ats_ref may be stale, or the customer requires a validator)`,
          })
        }
        return
      }

      const primary = group.employers[0]
      const parsedRows: ParsedResult[] =
        group.source.kind === "attract"
          ? parseAttractList(html, primary.name, group.source.base)
          : parseExtList(html, primary.name, group.source.base)

      for (const parsed of parsedRows) {
        if (opts.query && !matchesQuery(opts.query, [parsed.queryText])) continue
        if (opts.jobage !== undefined && !(parsed.result.date && isWithinDays(parsed.result.date, opts.jobage))) continue
        if (opts.location) {
          if (!parsed.locationText) {
            slot.unknown.push(parsed)
            continue
          }
          if (!locationMatches(parsed.locationText, opts.location, deps.area)) continue
        }
        slot.known.push(parsed)
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      for (const employer of group.employers) {
        errors.push({ employer: employer.name, error: message })
      }
    }
  })

  const pooled: JobResult[] = []
  // ReachMee list pages often omit location (Asplan's "Sted" column is blank;
  // Sweco's Attract table has no location column at all). When a location
  // filter is requested, defer those rows and read their detail page instead
  // of dropping them as non-matches.
  const unknownLocation: Array<{ employer: Employer; parsed: ParsedResult }> = []
  for (let i = 0; i < groups.length; i++) {
    const primary = groups[i].employers[0]
    for (const parsed of groupRows[i].known) pooled.push(parsed.result)
    for (const parsed of groupRows[i].unknown) unknownLocation.push({ employer: primary, parsed })
  }

  if (opts.location && unknownLocation.length > 0) {
    const cap = opts.locationDetailLimit ?? 200
    if (unknownLocation.length > cap) {
      warnings.push(
        `${unknownLocation.length - cap} listing(s) with no location were not checked because --location-detail-limit=${cap}; raise it to include them.`,
      )
    }

    const detailItems = unknownLocation.slice(0, cap)
    const detailResults: Array<JobResult | null> = detailItems.map(() => null)
    await mapLimit(
      detailItems.map((item, index) => ({ item, index })),
      MAX_CONCURRENCY,
      async ({ item, index }) => {
        try {
          const target = normalizeDetailTarget(item.parsed.result.url)
          if (!target) return
          const html = await deps.fetchText(target.url)
          if (!html) return
          const detail =
            target.kind === "attract"
              ? parseAttractDetail(html, target, item.employer.name)
              : parseExtDetail(html, target, item.employer.name)
          if (detail.location && locationMatches(detail.location, opts.location, deps.area)) {
            item.parsed.result.location = detail.location
            detailResults[index] = item.parsed.result
          }
        } catch {
          // A detail fetch failure just leaves the row out of the location-filtered
          // pool; it is not an employer-level list failure.
        }
      },
    )
    for (const result of detailResults) {
      if (result) pooled.push(result)
    }
  }

  const results: JobResult[] = []
  const seen = new Set<string>()
  for (const result of pooled) {
    const key = canonicalResultKey(result)
    if (seen.has(key)) continue
    seen.add(key)
    results.push(result)
  }

  errors.sort((a, b) => a.employer.localeCompare(b.employer))
  return { results: sortResults(results), errors, warnings }
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
