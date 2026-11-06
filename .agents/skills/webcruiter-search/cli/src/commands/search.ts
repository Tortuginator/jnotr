import {
  MAX_CONCURRENCY,
  MAX_PER_EMPLOYER,
  PAGE_SIZE,
  SEARCH_API,
  fetchText,
  filterEmployers,
  fold,
  htmlToText,
  isWithinDays,
  loadArea,
  loadRegistry,
  locationMatches,
  mapLimit,
  matchesQuery,
  paginate,
  sortResults,
  stripInvisible,
  toIsoDate,
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
  format: "json" | "table" | "plain"
}

export interface WebcruiterAdvert {
  Id?: string | number
  TenantId?: string | number
  CompanyName?: string
  Heading?: string
  HeadingNotOverruled?: string
  JobType?: string
  JobCategory?: string
  Presentation?: string
  PublishedDate?: string
  PublishedIntranetDate?: string
  ApplicationDeadline?: string
  Workplace?: string
  Workplace2?: string
  Workplace3?: string
  WorkPlaceFacet?: string
  WorkPlaceFacet2?: string | string[]
  WorkPlaceFacet3?: string | string[]
  OpenAdvertUrl?: string
}

interface WebcruiterResponse {
  Total?: number
  Data?: WebcruiterAdvert[]
}

export interface SearchDeps {
  employers: Employer[]
  area: Area | null
  fetchText: (url: string, init?: FetchInit) => Promise<string | null>
}

export const defaultDeps = (): SearchDeps => ({
  employers: filterEmployers(loadRegistry(), "webcruiter"),
  area: loadArea(),
  fetchText,
})

/**
 * Resolve a registry `ats_ref` to a Webcruiter tenant/company-lock id.
 *
 * Accepted forms observed in the registry (6 Nov 2026):
 *   companylock=7254
 *   https://960040.webcruiter.no
 *   https://23151000.webcruiter.no
 *   https://7254.webcruiter.no/Main/Recruit/Public/5198357738
 *   https://candidate.webcruiter.com/nb-no/Home/companyadverts?companylock=7254
 */
export function resolveTenant(ref: string): string | null {
  const trimmed = (ref ?? "").trim()
  if (!trimmed) return null
  const lock = trimmed.match(/companylock=(\d+)/i)
  if (lock) return lock[1]
  const host = trimmed.match(/https?:\/\/(\d+)\.webcruiter\.no(?:\/|$)/i)
  if (host) return host[1]
  if (/^\d+$/.test(trimmed)) return trimmed
  return null
}

export function buildSearchBody(page: number, pageSize = PAGE_SIZE): string {
  return JSON.stringify({
    take: pageSize,
    skip: (page - 1) * pageSize,
    page,
    pageSize,
  })
}

export function buildSearchUrl(tenant: string): string {
  return `${SEARCH_API}/${tenant}?lang=nb-NO`
}

function asString(value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value === "number") return String(value)
  return ""
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(asString).filter(Boolean)
  const single = asString(value)
  return single ? [single] : []
}

function firstNonEmpty(values: string[]): string | null {
  for (const value of values) {
    const trimmed = value.replace(/\s+/g, " ").trim()
    if (trimmed) return trimmed
  }
  return null
}

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const trimmed = value.replace(/\s+/g, " ").trim()
    if (!trimmed) continue
    const key = fold(trimmed)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
  }
  return out
}

/** Normalise one advert from the companysearch response. */
export function parseWebcruiterItem(item: WebcruiterAdvert, tenant: string, employerName: string): ParsedResult | null {
  const advertId = asString(item.Id).trim()
  if (!advertId) return null

  const workplaceFields = [item.Workplace, item.Workplace2, item.Workplace3].map(asString)
  const facetPlaces = [asString(item.WorkPlaceFacet)]
    .concat(asStringArray(item.WorkPlaceFacet3))
    .concat(asStringArray(item.WorkPlaceFacet2))
  const workplace = workplaceFields.concat(facetPlaces)

  const title = firstNonEmpty([asString(item.Heading), asString(item.HeadingNotOverruled)]) ?? "(untitled)"
  const workPlaces = uniqueNonEmpty(workplaceFields)
  const location = workPlaces.length ? workPlaces.join("; ") : firstNonEmpty(facetPlaces)
  const date = toIsoDate(asString(item.PublishedDate)) ?? toIsoDate(asString(item.PublishedIntranetDate))

  const url =
    asString(item.OpenAdvertUrl).trim() ||
    `https://${tenant}.webcruiter.no/Main/Recruit/Public/${advertId}`

  const result: JobResult = {
    id: `${tenant}:${advertId}`,
    title,
    company: employerName.trim() || firstNonEmpty([asString(item.CompanyName)]),
    location,
    date,
    url,
  }

  return {
    result,
    locationText: workplace.join(" "),
    queryText: [
      title,
      asString(item.CompanyName),
      asString(item.HeadingNotOverruled),
      asString(item.JobType),
      asString(item.JobCategory),
      htmlToText(asString(item.Presentation)),
      workplace.join(" "),
    ]
      .filter(Boolean)
      .join(" "),
  }
}

async function fetchAllForTenant(tenant: string, fetcher: SearchDeps["fetchText"]): Promise<WebcruiterAdvert[]> {
  const adverts: WebcruiterAdvert[] = []
  let page = 1
  let total = Number.POSITIVE_INFINITY

  while (adverts.length < Math.min(total, MAX_PER_EMPLOYER) && page <= 10) {
    const text = await fetcher(buildSearchUrl(tenant), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: buildSearchBody(page),
    })
    if (text === null) break

    const parsed = JSON.parse(text) as WebcruiterResponse
    total = Number(parsed.Total ?? 0)
    const data = Array.isArray(parsed.Data) ? parsed.Data : []
    if (data.length === 0) break

    adverts.push(...data)
    if (adverts.length >= total) break
    page++
  }

  return adverts.slice(0, MAX_PER_EMPLOYER)
}

export async function collectResults(
  opts: SearchOpts,
  deps: SearchDeps = defaultDeps(),
): Promise<{ results: JobResult[]; errors: MetaError[] }> {
  if (opts.location && fold(opts.location) === "area" && !deps.area) {
    throw new Error("job_scraper/area.json is missing, so --location area cannot be applied")
  }

  const errors: MetaError[] = []
  const pooled: JobResult[] = []

  await mapLimit(deps.employers, MAX_CONCURRENCY, async (employer) => {
    try {
      const tenant = resolveTenant(employer.atsRef)
      if (!tenant) {
        errors.push({
          employer: employer.name,
          error: "no Webcruiter tenant/company-lock in ats_ref (expected companylock=<id> or https://<id>.webcruiter.no)",
        })
        return
      }

      const adverts = await fetchAllForTenant(tenant, deps.fetchText)
      for (const advert of adverts) {
        const parsed = parseWebcruiterItem(advert, tenant, employer.name)
        if (!parsed) continue
        if (opts.query && !matchesQuery(opts.query, [parsed.queryText])) continue
        if (opts.location && !locationMatches(parsed.locationText, opts.location, deps.area)) continue
        if (opts.jobage !== undefined && !(parsed.result.date && isWithinDays(parsed.result.date, opts.jobage))) continue
        pooled.push(parsed.result)
      }
    } catch (e) {
      errors.push({ employer: employer.name, error: e instanceof Error ? e.message : String(e) })
    }
  })

  errors.sort((a, b) => a.employer.localeCompare(b.employer))
  return { results: sortResults(pooled), errors }
}

function displayId(id: string): string {
  return id
}

function renderTable(results: JobResult[]): string {
  if (results.length === 0) return "No results."
  const rows = results.map((r) => {
    const title = (r.title || "").slice(0, 40).padEnd(40)
    const company = (r.company || "—").slice(0, 24).padEnd(24)
    const location = (r.location || "—").slice(0, 20).padEnd(20)
    const date = r.date || "—"
    return `${displayId(r.id).padEnd(19)} ${title} ${company} ${location} ${date}`
  })
  const header =
    "ID".padEnd(19) + " " + "TITLE".padEnd(40) + " " + "COMPANY".padEnd(24) + " " + "LOCATION".padEnd(20) + " DATE"
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
    const emitted = paginate(results, opts.page, opts.limit).map((result) => stripInvisible(result))

    if (opts.format === "table") {
      process.stdout.write(renderTable(emitted) + "\n")
    } else if (opts.format === "plain") {
      process.stdout.write(renderPlain(emitted) + "\n")
    } else {
      process.stdout.write(
        JSON.stringify(
          { meta: { count: emitted.length, page: opts.page, errors: stripInvisible(errors) }, results: emitted },
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
