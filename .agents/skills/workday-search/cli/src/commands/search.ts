import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  buildLocationCandidates,
  buildSearchBody,
  cleanInline,
  companyForPosting,
  descriptorMatches,
  detailMatchesLocation,
  fetchDetailInfo,
  fetchSearch,
  findLocationFacets,
  groupEmployers,
  HttpError,
  isAmbiguousLocationText,
  isWithinDays,
  loadArea,
  loadRegistry,
  matchesQueryText,
  normalizeLocation,
  parsePostedOn,
  publicPostingUrl,
  stripInvisible,
  writeError,
  type AreaFile,
  type DetailInfo,
  type EmployerGroup,
  type RegistryError,
  type SearchPosting,
  type SearchResponse,
} from "../helpers.js"

export interface SearchOpts {
  query?: string
  location?: string
  jobage?: number
  page: number
  limit?: number
  format: "json" | "table" | "plain"
  locationDetailLimit?: number
}

export interface SearchResult {
  id: string | null
  title: string | null
  company: string | null
  location: string | null
  date: string | null
  url: string | null
}

interface GroupResult {
  results: SearchResult[]
  errors: RegistryError[]
}

interface DetailBudget {
  left: number
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

function toResult(posting: SearchPosting, group: EmployerGroup, externalPath: string): SearchResult {
  const site = group.primary.site
  return {
    id: `${site.tenant}/${site.site}${externalPath}`,
    title: cleanInline(posting.title),
    company: companyForPosting(posting, group),
    location: cleanInline(posting.locationsText),
    date: parsePostedOn(posting.postedOn),
    url: publicPostingUrl(site, externalPath),
  }
}

async function detailFor(site: EmployerGroup["primary"]["site"], externalPath: string): Promise<DetailInfo | null> {
  try {
    return await fetchDetailInfo(site, externalPath)
  } catch {
    return null
  }
}

async function searchGroup(
  group: EmployerGroup,
  opts: SearchOpts,
  candidates: Set<string> | null,
  pageSize: number,
  offset: number,
  budget: DetailBudget,
): Promise<GroupResult> {
  const site = group.primary.site
  const errors: RegistryError[] = []
  const label = group.employers.map((employer) => employer.name).join(" / ")

  try {
    let facetGroups: Record<string, string[]> = {}
    let baselineTotal: number | null = null
    if (candidates || opts.query) {
      try {
        const probe = await fetchSearch(site, buildSearchBody({ appliedFacets: {}, limit: 1, offset: 0, searchText: "" }))
        baselineTotal = typeof probe.total === "number" ? probe.total : null
        if (candidates) facetGroups = findLocationFacets(probe.facets, candidates)
      } catch (error) {
        // A failed probe is only fatal to the location facet path; the main
        // query (and the unfiltered fallback) can still succeed.
        if (candidates) errors.push({ employer: label, error: `location facet probe failed: ${errorMessage(error)}` })
      }
    }

    let usedFacets = Object.keys(facetGroups).length > 0
    const request = (facets: Record<string, string[]>) =>
      fetchSearch(
        site,
        buildSearchBody({
          appliedFacets: facets,
          limit: pageSize,
          offset,
          searchText: opts.query ?? "",
        }),
      )

    let response: SearchResponse
    try {
      response = await request(usedFacets ? facetGroups : {})
    } catch (error) {
      // NorgesGruppen rejects `appliedFacets.locations` with HTTP 400 even though
      // it exposes the facet. Fall back to listing and matching `locationsText`.
      if (usedFacets && error instanceof HttpError && error.status === 400) {
        usedFacets = false
        response = await request({})
      } else {
        throw error
      }
    }

    const postings = Array.isArray(response.jobPostings) ? response.jobPostings : []
    const titleHits = opts.query
      ? postings.filter((posting) => matchesQueryText(posting.title ?? "", opts.query!)).length
      : 0
    // The API-side searchText is verified live. Detect a site silently ignoring
    // it by comparing the total with the unfiltered baseline: an unchanged total
    // plus zero title hits means the query had no effect. Only then do we fetch
    // details and client-filter title + description. A query that reduces the
    // total (for example "Trondheim" matching locations) is honored as-is.
    const queryIgnored =
      Boolean(opts.query) &&
      baselineTotal !== null &&
      typeof response.total === "number" &&
      baselineTotal > 0 &&
      response.total === baselineTotal &&
      titleHits === 0
    const queryFallback = queryIgnored

    const results: SearchResult[] = []
    for (const posting of postings) {
      if (!posting || typeof posting !== "object") continue
      const externalPath = typeof posting.externalPath === "string" ? posting.externalPath : ""
      if (!externalPath.startsWith("/job/")) continue

      const date = parsePostedOn(posting.postedOn)
      if (opts.jobage !== undefined && date && !isWithinDays(date, opts.jobage)) continue

      if (candidates) {
        if (!usedFacets) {
          const locationsText = posting.locationsText ?? null
          if (isAmbiguousLocationText(locationsText)) {
            if (budget.left <= 0) continue
            budget.left--
            const info = await detailFor(site, externalPath)
            if (!info || !detailMatchesLocation(info, candidates)) continue
          } else if (!locationsText || !descriptorMatches(locationsText, candidates)) {
            continue
          }
        }
      }

      if (queryFallback) {
        if (!matchesQueryText(posting.title ?? "", opts.query!)) {
          if (budget.left <= 0) continue
          budget.left--
          const info = await detailFor(site, externalPath)
          if (!info) continue
          if (!matchesQueryText(`${info.title ?? ""} ${info.jobDescription ?? ""}`, opts.query!)) continue
        }
      }

      results.push(toResult(posting, group, externalPath))
    }

    return { results, errors }
  } catch (error) {
    return { results: [], errors: [...errors, { employer: label, error: errorMessage(error) }] }
  }
}

function renderTable(results: SearchResult[]): string {
  if (results.length === 0) return "No results."
  const rows = results.map((result) => {
    const id = (result.id || "—").slice(0, 34).padEnd(34)
    const title = (result.title || "—").slice(0, 40).padEnd(40)
    const company = (result.company || "—").slice(0, 26).padEnd(26)
    const location = (result.location || "—").slice(0, 24).padEnd(24)
    return `${id} ${title} ${company} ${location} ${result.date || "—"}`
  })
  const header =
    "ID".padEnd(34) +
    " " +
    "TITLE".padEnd(40) +
    " " +
    "COMPANY".padEnd(26) +
    " " +
    "LOCATION".padEnd(24) +
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
    const area: AreaFile | null = loadArea()
    const areaMode = location ? normalizeLocation(location) === "area" : false
    if (areaMode && !area) {
      writeError("Location 'area' needs job_scraper/area.json; the file was not found or is invalid.", "NO_AREA")
      return 1
    }
    const candidates = location ? buildLocationCandidates(location, area) : null

    const pageSize = Math.min(opts.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
    const offset = (opts.page - 1) * pageSize
    const groups = groupEmployers(registry.employers)
    const budget: DetailBudget = { left: opts.locationDetailLimit ?? 20 }

    const groupResults = await mapLimit(groups, 4, (group) =>
      searchGroup(group, opts, candidates, pageSize, offset, budget),
    )

    const errors: RegistryError[] = [...registry.errors]
    const results: SearchResult[] = []
    for (const groupResult of groupResults) {
      errors.push(...groupResult.errors)
      results.push(...groupResult.results)
    }

    results.sort((a, b) => {
      if (a.date && b.date && a.date !== b.date) return b.date.localeCompare(a.date)
      if (a.date && !b.date) return -1
      if (!a.date && b.date) return 1
      return (a.company ?? "").localeCompare(b.company ?? "") || (a.title ?? "").localeCompare(b.title ?? "")
    })

    const seen = new Set<string>()
    const deduped: SearchResult[] = []
    for (const result of results) {
      const key = (result.url || `${result.id}`).toLowerCase()
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
