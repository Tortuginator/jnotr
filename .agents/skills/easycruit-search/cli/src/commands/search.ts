import {
  DEFAULT_DETAIL_LIMIT,
  DEFAULT_LIMIT,
  canonicalVacancyUrl,
  combineLocation,
  employerLocationHint,
  fetchPublicDetail,
  fetchXml,
  listXmlUrl,
  loadArea,
  loadRegistry,
  locationMatches,
  normalizeDate,
  normalizeText,
  paginate,
  parseRss,
  parseVacancyList,
  rssDescriptionsByTitle,
  rssUrl,
  stripInvisible,
  textMatchesQuery,
  withinJobAge,
  writeError,
  type AreaFile,
  type Employer,
  type FetchLike,
  type JobResult,
  type RegistryError,
} from "../helpers.js"

export interface SearchOpts {
  query?: string
  location?: string
  jobage?: number
  page: number
  limit?: number
  detailLimit?: number
  format: "json" | "table" | "plain"
}

export interface SearchDeps {
  fetchImpl?: FetchLike
}

interface Candidate {
  slug: string
  vacancyId: string
  baseUrl: string
  employerName: string
  title: string | null
  company: string | null
  rawLocation: string | null
  hint: string | null
  detailLocation: string | null
  date: string | null
  url: string
}

const CONCURRENCY = 4

export class DetailBudget {
  private left: number
  constructor(limit: number) {
    this.left = Math.max(0, limit)
  }
  take(): boolean {
    if (this.left <= 0) return false
    this.left--
    return true
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
      const index = next++
      if (index >= items.length) return
      try {
        out[index] = { ok: true, value: await worker(items[index]) }
      } catch (error) {
        out[index] = { ok: false, error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()))
  return out
}

export async function searchEmployer(
  employer: Employer,
  opts: SearchOpts,
  area: AreaFile | null,
  budget: DetailBudget,
  fetchImpl: FetchLike,
): Promise<{ results: Candidate[]; errors: RegistryError[] }> {
  // The XML joblist is the only public feed with unique vacancy IDs. The RSS
  // feed supplies descriptions but its <link> is identical for every item, and
  // descriptions are only used for --query matching, so a location-only search
  // must not spend a second request on it.
  const xml = await fetchXml(listXmlUrl(employer.baseUrl), fetchImpl)
  if (!xml) throw new Error("joblist returned 404 or was empty")
  const vacancies = parseVacancyList(xml)

  const errors: RegistryError[] = []
  const reported = new Set<string>()
  const reportDetailError = (message: string): void => {
    if (reported.has(message)) return
    reported.add(message)
    errors.push({ employer: employer.name, error: message })
  }

  let descriptions = new Map<string, string>()
  if (opts.query) {
    try {
      const rss = await fetchXml(rssUrl(employer.baseUrl), fetchImpl)
      if (rss) descriptions = rssDescriptionsByTitle(parseRss(rss))
    } catch {
      // The RSS descriptions are an optimization; the XML list already gives us
      // IDs, titles, dates and workplace. Continue without them.
    }
  }
  const hint = employerLocationHint(employer.name, area)

  const results: Candidate[] = []
  for (const vacancy of vacancies) {
    const title = vacancy.title ?? vacancy.titleHeading ?? null
    let description = title ? descriptions.get(normalizeText(title)) ?? null : null
    let location = vacancy.location ?? null
    const date = normalizeDate(vacancy.dateStart)

    if (opts.jobage !== undefined && !withinJobAge(date, opts.jobage)) continue

    if (opts.query) {
      let matches = textMatchesQuery(`${title ?? ""}\n${description ?? ""}`, opts.query)
      if (!matches && !description && budget.take()) {
        const outcome = await fetchPublicDetail(employer.baseUrl, vacancy.id, fetchImpl)
        if (outcome.error) reportDetailError(outcome.error)
        if (outcome.detail?.description) {
          description = outcome.detail.description
          matches = textMatchesQuery(`${title ?? ""}\n${description}`, opts.query)
        }
        if (outcome.detail?.location) location = outcome.detail.location
      }
      if (!matches) continue
    }

    if (opts.location) {
      let matches = locationMatches(combineLocation(location, hint, employer.name), opts.location, area)
      if (!matches && !location && budget.take()) {
        const outcome = await fetchPublicDetail(employer.baseUrl, vacancy.id, fetchImpl)
        if (outcome.error) reportDetailError(outcome.error)
        if (outcome.detail?.location) {
          location = outcome.detail.location
          matches = locationMatches(combineLocation(location, hint, employer.name), opts.location, area)
        }
      }
      if (!matches) continue
    }

    results.push({
      slug: employer.slug,
      vacancyId: vacancy.id,
      baseUrl: employer.baseUrl,
      employerName: employer.name,
      title,
      company: employer.name || null,
      rawLocation: location,
      hint,
      detailLocation: null,
      date,
      url: vacancy.vacancyUrl ?? canonicalVacancyUrl(employer.slug, vacancy.id),
    })
  }

  return { results, errors }
}

function toResult(candidate: Candidate): JobResult {
  return {
    id: `${candidate.slug}/${candidate.vacancyId}`,
    title: candidate.title,
    company: candidate.company,
    location: combineLocation(candidate.detailLocation ?? candidate.rawLocation, candidate.hint, candidate.employerName),
    date: candidate.date,
    url: candidate.url,
  }
}

function renderTable(results: JobResult[]): string {
  if (results.length === 0) return "No results."
  const rows = results.map((result) => {
    const id = (result.id || "—").slice(0, 26).padEnd(26)
    const title = (result.title || "(untitled)").slice(0, 40).padEnd(40)
    const company = (result.company || "—").slice(0, 30).padEnd(30)
    const location = (result.location || "—").slice(0, 30).padEnd(30)
    return `${id} ${title} ${company} ${location} ${result.date || "—"}`
  })
  const header =
    "ID".padEnd(26) +
    " " +
    "TITLE".padEnd(40) +
    " " +
    "COMPANY".padEnd(30) +
    " " +
    "LOCATION".padEnd(30) +
    " DATE"
  return [header, "-".repeat(header.length), ...rows].join("\n")
}

function renderPlain(results: JobResult[]): string {
  if (results.length === 0) return "No results."
  return results
    .map((result) =>
      [
        result.title || "(untitled)",
        `  ${result.company || "—"} · ${result.location || "—"} · ${result.date || "—"}`,
        `  id: ${result.id}`,
        `  ${result.url || "—"}`,
      ].join("\n"),
    )
    .join("\n\n")
}

export async function runSearch(opts: SearchOpts, deps: SearchDeps = {}): Promise<number> {
  try {
    const registry = loadRegistry()
    if (!registry) {
      writeError(
        "No employer registry found. Expected job_scraper/employers.csv (or trondheim-patches/employers.seed.csv).",
        "NO_REGISTRY",
      )
      return 1
    }

    const area = loadArea()
    const wantsArea =
      opts.location !== undefined && ["area", "omradet", "trondheimsomradet"].includes(normalizeText(opts.location))
    if (wantsArea && !area) {
      writeError("Location 'area' needs job_scraper/area.json; the file was not found or is invalid.", "NO_AREA")
      return 1
    }

    const fetchImpl = deps.fetchImpl ?? fetch
    const budget = new DetailBudget(opts.detailLimit ?? DEFAULT_DETAIL_LIMIT)
    const employers = registry.employers
    const settled = await pool(employers, CONCURRENCY, (employer) =>
      searchEmployer(employer, opts, area, budget, fetchImpl),
    )

    const errors: RegistryError[] = [...registry.errors]
    const byId = new Map<string, Candidate>()
    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i]
      if (!outcome.ok) {
        errors.push({ employer: employers[i].name, error: errorMessage(outcome.error) })
        continue
      }
      errors.push(...outcome.value.errors)
      for (const candidate of outcome.value.results) {
        const key = `${candidate.slug}/${candidate.vacancyId}`
        if (!byId.has(key)) byId.set(key, candidate)
      }
    }

    const all = [...byId.values()].sort((a, b) => {
      const byDate = (b.date ?? "").localeCompare(a.date ?? "")
      if (byDate !== 0) return byDate
      return (a.title ?? "").localeCompare(b.title ?? "", "nb")
    })

    const pageItems = paginate(all, opts.page, opts.limit ?? DEFAULT_LIMIT)
    // Fill the human-readable workplace from div.jd-location for the rows we
    // are about to print. Bounded by --detail-limit across the whole run.
    const enrichment = await pool(pageItems, CONCURRENCY, async (candidate) => {
      if (!budget.take()) return null
      const outcome = await fetchPublicDetail(candidate.baseUrl, candidate.vacancyId, fetchImpl)
      if (outcome.detail) candidate.detailLocation = outcome.detail.location
      return outcome.error ? { employer: candidate.employerName, error: outcome.error } : null
    })
    const seenErrors = new Set(errors.map((entry) => `${entry.employer}\u0000${entry.error}`))
    for (const item of enrichment) {
      if (!item.ok || !item.value) continue
      const key = `${item.value.employer}\u0000${item.value.error}`
      if (seenErrors.has(key)) continue
      seenErrors.add(key)
      errors.push(item.value)
    }

    const results = stripInvisible(pageItems.map(toResult))
    const cleanErrors = stripInvisible(errors)

    if (opts.format === "table") {
      process.stdout.write(renderTable(results) + "\n")
      if (cleanErrors.length > 0) {
        process.stderr.write(`(${cleanErrors.length} employer(s) reported errors; use --format json for meta.errors)\n`)
      }
    } else if (opts.format === "plain") {
      process.stdout.write(renderPlain(results) + "\n")
      if (cleanErrors.length > 0) {
        process.stderr.write(`(${cleanErrors.length} employer(s) reported errors; use --format json for meta.errors)\n`)
      }
    } else {
      process.stdout.write(
        JSON.stringify(
          {
            meta: {
              count: results.length,
              page: opts.page,
              totalMatched: all.length,
              errors: cleanErrors,
            },
            results,
          },
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
