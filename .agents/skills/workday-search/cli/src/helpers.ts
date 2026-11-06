// Workday public career-site JSON API.
//
// Zero runtime dependencies: Bun's fetch plus regex/JSON. The CXS endpoints
// behind a public Workday career site are unauthenticated; the site's
// robots.txt allows the career-site paths (see url-reference.md).
//
// Registry rows with `ats=workday` carry a public career-site URL as `ats_ref`.
// That URL supplies the API origin, tenant (first host label) and site (first
// non-locale path segment). Nothing is guessed.

import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

export const UA = "Mozilla/5.0 (compatible; workday-search-cli/1.0)"
export const DEFAULT_PAGE_SIZE = 20
// Workday CXS returns HTTP 400 for page sizes above 20 on the tenants used
// here. The CLI caps each request and pages until --limit is satisfied.
export const MAX_PAGE_SIZE = 20

export function writeError(error: string, code: string): void {
  process.stderr.write(JSON.stringify(stripInvisible({ error, code })) + "\n")
}

export class HttpError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function jitter(): number {
  return Math.floor(Math.random() * 500)
}

/** Fetch JSON with exponential backoff and jitter on 429/5xx. Returns null on 404. */
export async function jsonFetch(url: string, init?: RequestInit): Promise<unknown | null> {
  const maxRetries = 6
  let delay = 500
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response: Response
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          "User-Agent": UA,
          Accept: "application/json",
          // Ask for English so Workday's relative dates and location labels stay
          // in the stable form this parser understands. Norwegian labels are
          // parsed defensively below as well.
          "Accept-Language": "en-US,en;q=0.9",
          ...(init?.headers ?? {}),
        },
        redirect: "follow",
        signal: AbortSignal.timeout(20000),
      })
    } catch (error) {
      if (attempt === maxRetries) throw error
      await sleep(delay + jitter())
      delay = Math.min(delay * 2, 8000)
      continue
    }
    if (response.status === 429 || response.status >= 500) {
      if (attempt === maxRetries) {
        throw new HttpError(`Request failed: ${response.status} ${response.statusText}`, response.status)
      }
      await sleep(delay + jitter())
      delay = Math.min(delay * 2, 8000)
      continue
    }
    if (response.status === 404) return null
    if (!response.ok) {
      throw new HttpError(`Request failed: ${response.status} ${response.statusText}`, response.status)
    }
    const text = await response.text()
    if (!text.trim()) return null
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`Response was not valid JSON: ${url}`)
    }
  }
  throw new Error("Request failed after max retries")
}

// ---------------------------------------------------------------------------
// Fixtures (offline tests)

function fixtureDir(): string | null {
  const dir = process.env.WORKDAY_FIXTURE_DIR?.trim()
  return dir ? dir : null
}

function sanitizeFixtureName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_")
}

function readFixtureFile(names: string[]): string | null {
  const dir = fixtureDir()
  if (!dir) return null
  for (const name of names) {
    const path = join(dir, name)
    if (existsSync(path)) return readFileSync(path, "utf8")
  }
  return null
}

function parseFixture(text: string, label: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`fixture is not valid JSON: ${label}`)
  }
}

function searchFixtureNames(
  site: WorkdaySite,
  offset: number,
  hasQuery: boolean,
  hasFacets: boolean,
): string[] {
  const base = `${sanitizeFixtureName(site.tenant)}.${sanitizeFixtureName(site.site)}`
  const tags: string[] = []
  if (hasQuery) tags.push("query")
  if (hasFacets) tags.push("filtered")
  const names: string[] = []
  if (tags.length) {
    names.push(`${base}.search.${tags.join(".")}.${offset}.json`)
    names.push(`${base}.search.${tags.join(".")}.json`)
  }
  names.push(`${base}.search.${offset}.json`, `${base}.search.json`, "search.json")
  return names
}

function detailFixtureNames(site: WorkdaySite, externalPath: string): string[] {
  const base = `${sanitizeFixtureName(site.tenant)}.${sanitizeFixtureName(site.site)}`
  const path = sanitizeFixtureName(externalPath)
  return [
    `${base}.detail.${path}.json`,
    `detail.${path}.json`,
    `${base}.detail.json`,
    "detail.json",
  ]
}

// ---------------------------------------------------------------------------
// Career-site URL parsing

export interface WorkdaySite {
  origin: string
  host: string
  tenant: string
  site: string
  ref: string
}

const LOCALE = /^[a-z]{2}-[a-z]{2}$/i

/**
 * Parse a public Workday career-site URL.
 * `https://norconsult.wd3.myworkdayjobs.com/Norconsult_Career_Site` →
 * tenant `norconsult`, site `Norconsult_Career_Site`.
 *
 * Locale segments (`no-NO`, `en-US`) are skipped, so a URL such as
 * `https://norgesgruppen.wd3.myworkdayjobs.com/no-NO/karriere/job/...` still
 * resolves the site to `karriere`.
 */
export function parseWorkdayRef(ref: string): WorkdaySite | null {
  const raw = ref.trim()
  if (!raw) return null
  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return null
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null
  const host = url.hostname.toLowerCase()
  if (!/(^|\.)myworkdayjobs\.com$/i.test(host)) return null
  const tenant = host.split(".")[0]
  if (!tenant) return null

  const segments = url.pathname.split("/").filter(Boolean)
  let siteName: string | null = null
  for (const segment of segments) {
    if (LOCALE.test(segment)) continue
    if (segment.toLowerCase() === "job") break
    siteName = segment
    break
  }
  if (!siteName) return null

  return { origin: url.origin, host, tenant, site: siteName, ref }
}

export function searchApiUrl(site: WorkdaySite): string {
  return `${site.origin}/wday/cxs/${encodeURIComponent(site.tenant)}/${encodeURIComponent(site.site)}/jobs`
}

export function detailApiUrl(site: WorkdaySite, externalPath: string): string {
  return `${site.origin}/wday/cxs/${site.tenant}/${site.site}${externalPath}`
}

export function publicPostingUrl(site: WorkdaySite, externalPath: string): string {
  return `${site.origin}/${site.site}${externalPath}`
}

// ---------------------------------------------------------------------------
// Search request/response

export interface SearchBody {
  appliedFacets: Record<string, string[]>
  limit: number
  offset: number
  searchText: string
}

export interface SearchPosting {
  title?: string | null
  externalPath?: string | null
  timeType?: string | null
  locationsText?: string | null
  postedOn?: string | null
  bulletFields?: string[] | null
}

export interface SearchResponse {
  total?: number
  jobPostings?: SearchPosting[]
  facets?: unknown
  userAuthenticated?: boolean
}

export function buildSearchBody(opts: {
  appliedFacets?: Record<string, string[]>
  limit?: number
  offset?: number
  searchText?: string
}): SearchBody {
  const rawLimit = opts.limit ?? DEFAULT_PAGE_SIZE
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(rawLimit)))
  const offset = Math.max(0, Math.trunc(opts.offset ?? 0))
  return {
    appliedFacets: opts.appliedFacets ?? {},
    limit,
    offset,
    searchText: opts.searchText ?? "",
  }
}

/** POST one search page. Fixture mode reads the first matching fixture file. */
export async function fetchSearch(site: WorkdaySite, body: SearchBody): Promise<SearchResponse> {
  const dir = fixtureDir()
  if (dir) {
    const text = readFixtureFile(
      searchFixtureNames(site, body.offset, Boolean(body.searchText), Object.keys(body.appliedFacets).length > 0),
    )
    if (text === null) throw new Error(`fixture not found for ${site.tenant}/${site.site} search`)
    const parsed = parseFixture(text, `${site.tenant}/${site.site} search`)
    return (parsed ?? {}) as SearchResponse
  }
  const data = await jsonFetch(searchApiUrl(site), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  return (data ?? {}) as SearchResponse
}

export interface DetailInfo {
  id?: string | null
  title?: string | null
  jobDescription?: string | null
  location?: string | null
  additionalLocations?: string[] | null
  postedOn?: string | null
  startDate?: string | null
  endDate?: string | null
  timeType?: string | null
  jobReqId?: string | null
  externalUrl?: string | null
  country?: { descriptor?: string | null } | string | null
  jobRequisitionLocation?: { descriptor?: string | null } | null
  [key: string]: unknown
}

/** GET one posting's detail JSON. Returns null on 404 or an empty payload. */
export async function fetchDetailInfo(site: WorkdaySite, externalPath: string): Promise<DetailInfo | null> {
  const dir = fixtureDir()
  if (dir) {
    const text = readFixtureFile(detailFixtureNames(site, externalPath))
    if (text === null) throw new Error(`fixture not found for detail ${externalPath}`)
    const parsed = parseFixture(text, externalPath) as { jobPostingInfo?: DetailInfo } | null
    return parsed?.jobPostingInfo ?? null
  }
  const data = (await jsonFetch(detailApiUrl(site, externalPath))) as { jobPostingInfo?: DetailInfo } | null
  return data?.jobPostingInfo ?? null
}

// ---------------------------------------------------------------------------
// Output hygiene (copied from linkedin-search/cli/src/helpers.ts, the canonical
// implementation of this output boundary)

const INVISIBLE_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFE00-\uFE0F\uFEFF\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu

export function stripInvisible<T>(value: T): T {
  if (typeof value === "string") return value.replace(INVISIBLE_CHARS, "") as T
  if (Array.isArray(value)) return value.map(stripInvisible) as T
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stripInvisible(v)])) as T
  }
  return value
}

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr",
])

function isHiddenTag(attrs: string): boolean {
  for (const m of attrs.matchAll(/([^\s"'=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    const name = m[1].toLowerCase()
    const value = m[2] ?? m[3] ?? m[4] ?? ""
    if (name === "hidden") return true
    if (name === "style" && /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|mso-hide\s*:\s*all)\b/i.test(value)) {
      return true
    }
  }
  return false
}

/** Drop markup a browser never renders before tags are stripped. */
export function visibleHtml(html: string): string {
  const src = html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, "")
  const open = /<([a-zA-Z][a-zA-Z0-9-]*)(\s[^>]*)?>/g
  const kept: string[] = []
  let from = 0
  let m: RegExpExecArray | null
  while ((m = open.exec(src)) !== null) {
    if (!m[2] || !isHiddenTag(m[2])) continue
    const tag = m[1].toLowerCase()
    let end = open.lastIndex
    if (!VOID_TAGS.has(tag) && !m[0].endsWith("/>")) {
      const same = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi")
      same.lastIndex = end
      end = src.length
      let depth = 1
      let s: RegExpExecArray | null
      while ((s = same.exec(src)) !== null) {
        if (s[1]) depth--
        else if (!s[0].endsWith("/>")) depth++
        if (depth === 0) {
          end = same.lastIndex
          break
        }
      }
    }
    kept.push(src.slice(from, m.index))
    from = end
    open.lastIndex = end
  }
  kept.push(src.slice(from))
  return kept.join("")
}

function numericEntity(cp: number): string {
  return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ""
}

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => numericEntity(parseInt(dec, 10)))
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, hex) => numericEntity(parseInt(hex, 16)))
    .replace(/&nbsp;/g, " ")
}

/** Visible text of an inline HTML fragment, entities decoded, whitespace collapsed. */
export function cleanInline(html: string | null | undefined): string | null {
  if (!html) return null
  const text = decodeHtmlEntities(visibleHtml(html).replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
  return text || null
}

/** Visible text of a block of HTML, preserving paragraph and list breaks. */
export function htmlToText(html: string | null | undefined): string | null {
  if (!html) return null
  const withBreaks = visibleHtml(html)
    .replace(/\s+/g, " ")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|ul|ol|div|h[1-6]|tr|blockquote)>/gi, "\n")
  const text = withBreaks
    .split("\n")
    .map((line) => decodeHtmlEntities(line.replace(/<[^>]+>/g, " ")).replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return text || null
}

// ---------------------------------------------------------------------------
// Dates

function utcDayOffset(now: Date, days: number): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  date.setUTCDate(date.getUTCDate() - days)
  return date.toISOString().slice(0, 10)
}

/**
 * Workday search results publish a relative label, not a timestamp:
 * "Posted Today", "Posted Yesterday", "Posted 2 Days Ago", "Posted 30+ Days Ago".
 * Convert it to YYYY-MM-DD. An unrecognised label yields null.
 */
export function parsePostedOn(value: string | null | undefined, now = new Date()): string | null {
  if (!value) return null
  const text = value.trim().toLowerCase()
  const iso = text.match(/^(\d{4}-\d{2}-\d{2})/)
  if (iso) return iso[1]
  if (/(?:posted\s+)?(?:today|just now)/.test(text) || /publisert\s+i\s+dag/.test(text)) return utcDayOffset(now, 0)
  if (/(?:posted\s+)?yesterday/.test(text) || /i\s+går/.test(text)) return utcDayOffset(now, 1)
  const days = text.match(/(\d+)\+?\s+days?\s+ago/) || text.match(/(?:for\s+)?(\d+)\+?\s+dager?\s+siden/)
  if (days) return utcDayOffset(now, parseInt(days[1], 10))
  const months = text.match(/(\d+)\+?\s+months?\s+ago/) || text.match(/(?:for\s+)?(\d+)\+?\s+måneder?\s+siden/)
  if (months) return utcDayOffset(now, parseInt(months[1], 10) * 30)
  return null
}

export function isWithinDays(isoDate: string | null, days: number, now = new Date()): boolean {
  if (!isoDate) return false
  const time = new Date(`${isoDate}T00:00:00Z`).getTime()
  if (Number.isNaN(time)) return false
  const cutoff = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - (days - 1) * 86_400_000
  return time >= cutoff
}

// ---------------------------------------------------------------------------
// Location matching

/** Lower-case, diacritic-tolerant, whitespace-collapsed form for comparisons. */
export function normalizeLocation(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/ø/g, "o")
    .replace(/æ/g, "ae")
    .replace(/ß/g, "ss")
    .toLowerCase()
    .replace(/[.,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function stripCountrySuffix(value: string): string {
  return value.replace(/,\s*(?:norway|norge|no)\s*$/i, "").trim()
}

export interface AreaMunicipality {
  code?: string
  name: string
  aliases?: string[]
  places?: string[]
  postal_prefixes?: string[]
}

export interface AreaFile {
  name?: string
  default?: string
  municipalities: AreaMunicipality[]
}

function municipalityNames(municipality: AreaMunicipality): string[] {
  return [municipality.name, ...(municipality.aliases ?? []), ...(municipality.places ?? [])]
}

/**
 * Build the set of acceptable location descriptors. `area` unions every
 * municipality name, alias and place. A specific place expands to its whole
 * municipality, so `-l Heimdal` also accepts a `Trondheim` facet.
 */
export function buildLocationCandidates(location: string, area: AreaFile | null): Set<string> {
  const candidates = new Set<string>()
  const wanted = normalizeLocation(location)
  if (wanted === "area") {
    for (const municipality of area?.municipalities ?? []) {
      for (const name of municipalityNames(municipality)) {
        const normalized = normalizeLocation(name)
        if (normalized) candidates.add(normalized)
      }
    }
    return candidates
  }

  if (wanted) candidates.add(wanted)
  for (const municipality of area?.municipalities ?? []) {
    const municipalityLabels = [municipality.name, ...(municipality.aliases ?? [])].map(normalizeLocation)
    const isMunicipality = municipalityLabels.includes(wanted)
    const isPlace = (municipality.places ?? []).map(normalizeLocation).includes(wanted)
    if (isMunicipality) {
      // "Trondheim" accepts every district in the municipality.
      for (const name of municipalityNames(municipality)) {
        const normalized = normalizeLocation(name)
        if (normalized) candidates.add(normalized)
      }
    } else if (isPlace) {
      // "Heimdal" accepts Heimdal and the municipality label, not other districts.
      for (const label of municipalityLabels) if (label) candidates.add(label)
    }
  }
  return candidates
}

/** Match a Workday facet/location descriptor ("Rotvoll, Norway") against candidates. */
export function descriptorMatches(descriptor: string | null | undefined, candidates: Set<string>): boolean {
  // Split before normalising: normaliseLocation turns commas into spaces, which
  // would erase the separator in descriptors such as
  // "ASKO Midt-Norge, Trondheim".
  const cleaned = stripCountrySuffix(descriptor ?? "")
  const parts = cleaned.split(/\s+-\s+|,/).map((part) => normalizeLocation(part))
  if (parts.some((part) => part !== "" && candidates.has(part))) return true
  const normalized = normalizeLocation(cleaned)
  return normalized !== "" && candidates.has(normalized)
}

/** Workday groups multiple locations behind labels like "4 Locations". */
export function isAmbiguousLocationText(text: string | null | undefined): boolean {
  const value = (text ?? "").trim().toLowerCase()
  if (!value) return false
  if (/^\d+\s+locations?$/.test(value)) return true
  if (/^(?:multiple|several|various)\s+locations?$/.test(value)) return true
  return ["nordic", "norden", "scandinavia", "skandinavia"].includes(value)
}

/** True when a detail payload names a candidate location. */
export function detailMatchesLocation(info: DetailInfo, candidates: Set<string>): boolean {
  const values: Array<string | null | undefined> = [
    info.location,
    ...(Array.isArray(info.additionalLocations) ? info.additionalLocations : []),
    info.jobRequisitionLocation?.descriptor,
  ]
  return values.some((value) => typeof value === "string" && descriptorMatches(value, candidates))
}

function isLocationFacetParameter(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (value === "locations" || /^locationHierarchy\d+$/i.test(value))
  )
}

/**
 * Recursively find location facet ids whose descriptors match, grouped by the
 * facet parameter that must be used as the `appliedFacets` key. Most tenants use
 * `locations`; NorgesGruppen exposes a `locationHierarchy1` (Municipality)
 * facet, and the API rejects the same id under `locations` with HTTP 400.
 */
export function findLocationFacets(facets: unknown, candidates: Set<string>): Record<string, string[]> {
  const groups: Record<string, Set<string>> = {}
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (!value || typeof value !== "object") return
    const object = value as Record<string, unknown>
    if (isLocationFacetParameter(object.facetParameter) && Array.isArray(object.values)) {
      const ids = (groups[object.facetParameter] ??= new Set<string>())
      for (const facetValue of object.values) {
        if (!facetValue || typeof facetValue !== "object") continue
        const entry = facetValue as Record<string, unknown>
        if (
          typeof entry.descriptor === "string" &&
          typeof entry.id === "string" &&
          descriptorMatches(entry.descriptor, candidates)
        ) {
          ids.add(entry.id)
        }
      }
    }
    for (const nested of Object.values(object)) {
      if (Array.isArray(nested) || (nested && typeof nested === "object")) walk(nested)
    }
  }
  walk(facets)
  return Object.fromEntries(
    Object.entries(groups)
      .filter(([, ids]) => ids.size > 0)
      .map(([key, ids]) => [key, [...ids]]),
  )
}

/** Flat list of matching location facet ids (any facet parameter). */
export function findLocationFacetIds(facets: unknown, candidates: Set<string>): string[] {
  return Object.values(findLocationFacets(facets, candidates)).flat()
}

export function matchesQueryText(text: string | null | undefined, query: string): boolean {
  const wanted = normalizeLocation(query)
  if (!wanted) return true
  return normalizeLocation(text).includes(wanted)
}

// ---------------------------------------------------------------------------
// Registry

export interface Employer {
  name: string
  orgnr: string | null
  site: WorkdaySite
}

export interface RegistryError {
  employer: string
  error: string
}

export interface Registry {
  employers: Employer[]
  errors: RegistryError[]
  source: string
}

/** RFC-4180-ish CSV parse: quoted fields, escaped quotes, CRLF, newlines in quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') {
      inQuotes = true
    } else if (ch === ",") {
      row.push(field)
      field = ""
    } else if (ch === "\n") {
      row.push(field)
      field = ""
      rows.push(row)
      row = []
    } else if (ch !== "\r") {
      field += ch
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""))
}

function ancestorDirs(start: string): string[] {
  const dirs: string[] = []
  let current = start
  while (true) {
    dirs.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return dirs
}

function firstExisting(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

export function resolveRegistryPath(): string | null {
  const override = process.env.WORKDAY_REGISTRY?.trim()
  if (override) return existsSync(override) ? override : null
  const roots = [...ancestorDirs(process.cwd()), ...ancestorDirs(import.meta.dir)]
  return firstExisting(
    roots.flatMap((root) => [
      join(root, "job_scraper", "employers.csv"),
      join(root, "trondheim-patches", "employers.seed.csv"),
    ]),
  )
}

export function resolveAreaPath(): string | null {
  const override = process.env.WORKDAY_AREA?.trim()
  if (override) return existsSync(override) ? override : null
  const roots = [...ancestorDirs(process.cwd()), ...ancestorDirs(import.meta.dir)]
  return firstExisting(roots.map((root) => join(root, "job_scraper", "area.json")))
}

function isEnabled(value: string | undefined): boolean {
  if (value === undefined) return true
  return !["false", "0", "no", "nei", "disabled", "off"].includes(value.trim().toLowerCase())
}

function cell(row: string[], header: string[], name: string): string {
  const index = header.indexOf(name)
  return index === -1 ? "" : (row[index] ?? "").trim()
}

/**
 * Normalise registry rows into Workday employers. Missing/invalid `ats_ref`
 * rows are skipped and reported, never guessed. Disabled and non-Workday rows
 * are ignored silently.
 */
export function normalizeRegistry(text: string, source = "registry"): Registry {
  const rows = parseCsv(text)
  if (rows.length === 0) return { employers: [], errors: [], source }
  const header = rows[0].map((h) => h.trim().toLowerCase())
  const employers: Employer[] = []
  const errors: RegistryError[] = []

  for (const row of rows.slice(1)) {
    if (cell(row, header, "ats").toLowerCase() !== "workday") continue
    if (!isEnabled(cell(row, header, "enabled"))) continue
    const name = cell(row, header, "name") || cell(row, header, "orgnr") || "Unknown employer"
    const ref = cell(row, header, "ats_ref")
    if (!ref) {
      errors.push({ employer: name, error: "missing ats_ref; employer skipped" })
      continue
    }
    const site = parseWorkdayRef(ref)
    if (!site) {
      errors.push({ employer: name, error: `invalid ats_ref (not a Workday career-site URL): ${ref}` })
      continue
    }
    employers.push({ name, orgnr: cell(row, header, "orgnr") || null, site })
  }
  return { employers, errors, source }
}

export function loadRegistry(): Registry | null {
  const path = resolveRegistryPath()
  if (!path) return null
  return normalizeRegistry(readFileSync(path, "utf8"), path)
}

export function loadArea(): AreaFile | null {
  const path = resolveAreaPath()
  if (!path) return null
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as AreaFile
    if (!parsed || !Array.isArray(parsed.municipalities)) return null
    return parsed
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Employer grouping and attribution

export interface EmployerGroup {
  key: string
  primary: Employer
  employers: Employer[]
}

/** Group rows that share one Workday site (e.g. ASKO and MENY both use NorgesGruppen's site). */
export function groupEmployers(employers: Employer[]): EmployerGroup[] {
  const groups = new Map<string, EmployerGroup>()
  for (const employer of employers) {
    const key = `${employer.site.origin}/${employer.site.site}`.toLowerCase()
    const existing = groups.get(key)
    if (existing) existing.employers.push(employer)
    else groups.set(key, { key, primary: employer, employers: [employer] })
  }
  return [...groups.values()]
}

const BRAND_STOPWORDS = new Set([
  "as", "asa", "nuf", "ng", "the", "of", "og", "group", "gruppe", "norway", "norge", "midt", "norge",
])

function employerBrandTokens(name: string): string[] {
  return normalizeLocation(name)
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !BRAND_STOPWORDS.has(token))
}

/** The brand label in `bulletFields` (NorgesGruppen puts e.g. "MENY" there). */
function postingBrandLabel(posting: SearchPosting): string | null {
  for (const field of posting.bulletFields ?? []) {
    const value = cleanInline(field)
    if (!value) continue
    if (/^(?:JR|REQ|R\d|JobReq)/i.test(value)) continue
    if (/\d/.test(value) || value.length < 2) continue
    return value
  }
  return null
}

/**
 * Pick the name for a posting. Most sites have one registry row. When two rows
 * share a site (NorgesGruppen's ASKO and MENY), a brand token in the
 * title/path/bullet fields wins. A posting for another group brand (SPAR, Joker,
 * KIWI) keeps that brand as `company` rather than being falsely attributed to
 * the first registry row; an unknown employer keeps its own name.
 */
export function companyForPosting(posting: SearchPosting, group: EmployerGroup): string {
  if (group.employers.length === 1) return group.primary.name
  const haystack = normalizeLocation(
    [posting.title ?? "", posting.externalPath ?? "", ...(posting.bulletFields ?? [])].join(" "),
  )
  let best: Employer | null = null
  let bestScore = 0
  for (const employer of group.employers) {
    const score = employerBrandTokens(employer.name).filter((token) => haystack.includes(token)).length
    if (score > bestScore) {
      best = employer
      bestScore = score
    }
  }
  return best?.name ?? postingBrandLabel(posting) ?? group.primary.name
}

export function companyForDetail(
  info: DetailInfo,
  site: WorkdaySite,
  registry: Registry | null,
): string | null {
  if (!registry) return null
  const group = groupEmployers(registry.employers).find(
    (candidate) =>
      candidate.primary.site.tenant.toLowerCase() === site.tenant.toLowerCase() &&
      candidate.primary.site.site.toLowerCase() === site.site.toLowerCase(),
  )
  if (!group) return null
  return companyForPosting(
    {
      title: info.title ?? null,
      externalPath: null,
      bulletFields: [info.jobReqId ?? ""],
    },
    group,
  )
}

// ---------------------------------------------------------------------------
// Detail target parsing

export interface ResolvedTarget {
  site: WorkdaySite
  externalPath: string
  publicUrl: string
}

export type TargetResult = ResolvedTarget | { error: string; code: string }

function safeExternalPath(value: string): string | null {
  if (!value.startsWith("/job/")) return null
  if (value.includes("..") || value.includes("\\")) return null
  return value
}

/**
 * Accept:
 *   - a full Workday posting URL (preferred), with or without a locale prefix;
 *   - `<tenant>/<site>/job/...` (resolved through the registry for the wd host);
 *   - a bare `/job/...` externalPath when the registry has exactly one site.
 */
export function resolveTarget(input: string, registry: Registry | null): TargetResult {
  const trimmed = input.trim()
  if (!trimmed) return { error: "detail requires an <id|url>", code: "NO_ID" }

  const looksLikeUrl = /^https?:\/\//i.test(trimmed) || /^[a-z0-9.-]+\.myworkdayjobs\.com(\/|$)/i.test(trimmed)
  if (looksLikeUrl) {
    let url: URL
    try {
      url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
    } catch {
      return { error: `Not a usable Workday posting URL: "${trimmed}"`, code: "BAD_URL" }
    }
    const host = url.hostname.toLowerCase()
    if (!/(^|\.)myworkdayjobs\.com$/i.test(host)) {
      return { error: `Not a Workday posting URL: "${trimmed}"`, code: "BAD_URL" }
    }
    const segments = url.pathname.split("/").filter(Boolean)
    const jobIndex = segments.findIndex((segment) => segment.toLowerCase() === "job")
    if (jobIndex < 1) {
      return { error: `Workday posting URL does not contain a /job/ path: "${trimmed}"`, code: "BAD_URL" }
    }
    const siteName = segments[jobIndex - 1]
    if (!siteName || LOCALE.test(siteName)) {
      return { error: `Could not parse the Workday site from "${trimmed}"`, code: "BAD_URL" }
    }
    const externalPath = safeExternalPath(`/${segments.slice(jobIndex).join("/")}`)
    if (!externalPath) return { error: `Invalid Workday externalPath in "${trimmed}"`, code: "BAD_URL" }
    const site: WorkdaySite = {
      origin: url.origin,
      host,
      tenant: host.split(".")[0],
      site: siteName,
      ref: `${url.origin}/${siteName}`,
    }
    return { site, externalPath, publicUrl: publicPostingUrl(site, externalPath) }
  }

  const composite = trimmed.replace(/^\/+/, "").match(/^([^/]+)\/([^/]+)(\/job\/.*)$/i)
  if (composite) {
    const [, tenant, siteName, rawPath] = composite
    if (tenant.includes(".") || siteName.includes(".")) {
      return { error: `Not a Workday id: "${trimmed}"`, code: "BAD_ID" }
    }
    const externalPath = safeExternalPath(rawPath)
    if (!externalPath) return { error: `Invalid Workday externalPath in "${trimmed}"`, code: "BAD_ID" }
    const employer = registry?.employers.find(
      (candidate) =>
        candidate.site.tenant.toLowerCase() === tenant.toLowerCase() &&
        candidate.site.site.toLowerCase() === siteName.toLowerCase(),
    )
    if (!employer) {
      return {
        error: `No enabled Workday site matches "${tenant}/${siteName}". Pass the full posting URL instead.`,
        code: "BAD_ID",
      }
    }
    return {
      site: employer.site,
      externalPath,
      publicUrl: publicPostingUrl(employer.site, externalPath),
    }
  }

  const bare = trimmed.startsWith("/") ? trimmed : `/${trimmed}`
  const externalPath = safeExternalPath(bare)
  if (externalPath) {
    const groups = registry ? groupEmployers(registry.employers) : []
    if (groups.length === 0) {
      return {
        error: "A bare externalPath cannot be resolved without the employer registry. Pass the full posting URL instead.",
        code: "NO_REGISTRY",
      }
    }
    if (groups.length > 1) {
      return {
        error: `A bare externalPath is ambiguous with ${groups.length} Workday sites. Pass the full posting URL instead (search returns it as "url").`,
        code: "AMBIGUOUS_ID",
      }
    }
    const site = groups[0].primary.site
    return { site, externalPath, publicUrl: publicPostingUrl(site, externalPath) }
  }

  return {
    error: `Could not parse a Workday posting URL or id from "${trimmed}". Pass the full posting URL returned by search.`,
    code: "BAD_ID",
  }
}
