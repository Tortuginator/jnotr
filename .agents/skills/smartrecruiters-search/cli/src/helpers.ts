// Data source: SmartRecruiters' public postings API.
//
//   GET https://api.smartrecruiters.com/v1/companies/<slug>/postings
//   GET https://api.smartrecruiters.com/v1/companies/<slug>/postings/<id>
//
// No credentials. Zero runtime dependencies: Bun + fetch + regex. The employer
// list comes from job_scraper/employers.csv (rows with ats=smartrecruiters).

import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

export const DEFAULT_API_BASE = "https://api.smartrecruiters.com"
export const DEFAULT_JOBS_BASE = "https://jobs.smartrecruiters.com"
export const PAGE_SIZE = 100 // SmartRecruiters caps `limit` at 100.
export const DEFAULT_LIMIT = 50

const UA = "Mozilla/5.0 (compatible; smartrecruiters-search-cli/1.0)"

export function apiBase(): string {
  return (process.env.SMARTRECRUITERS_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, "")
}

export function jobsBase(): string {
  return (process.env.SMARTRECRUITERS_JOBS_BASE || DEFAULT_JOBS_BASE).replace(/\/+$/, "")
}

export function writeError(error: string, code: string): void {
  process.stderr.write(JSON.stringify({ error, code }) + "\n")
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface RawTextResponse {
  status: number
  ok: boolean
  statusText: string
  text: string
}

/**
 * Fetch text with exponential backoff and jitter on 429/5xx/connection errors.
 * Returns the raw response for every non-retried status (including 400/404) so
 * callers can decide whether a 404 means "not found" or "bad slug".
 */
export async function fetchTextRaw(
  url: string,
  fetchImpl: FetchLike = fetch,
  accept = "application/json",
): Promise<RawTextResponse | null> {
  const maxRetries = 6
  let delay = 500
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response: Response
    try {
      response = await fetchImpl(url, {
        headers: { "User-Agent": UA, Accept: accept },
        redirect: "follow",
        signal: AbortSignal.timeout(15000),
      })
    } catch (e) {
      if (attempt === maxRetries) {
        throw new Error(`could not reach ${url}: ${e instanceof Error ? e.message : String(e)}`)
      }
      await sleep(delay + Math.floor(Math.random() * 500))
      delay = Math.min(delay * 2, 8000)
      continue
    }
    if (response.status === 429 || response.status >= 500) {
      if (attempt === maxRetries) {
        throw new Error(`request failed: ${response.status} ${response.statusText}`)
      }
      await sleep(delay + Math.floor(Math.random() * 500))
      delay = Math.min(delay * 2, 8000)
      continue
    }
    return {
      status: response.status,
      ok: response.ok,
      statusText: response.statusText,
      text: await response.text(),
    }
  }
  throw new Error("request failed after retries")
}

/** Fetch JSON. Returns null on 404; throws on any other non-2xx or bad JSON. */
export async function apiGetJson<T>(url: string, fetchImpl: FetchLike = fetch): Promise<T | null> {
  const response = await fetchTextRaw(url, fetchImpl, "application/json")
  if (!response || response.status === 404) return null
  if (!response.ok) {
    throw new Error(`request failed: ${response.status} ${response.statusText}`)
  }
  try {
    return JSON.parse(response.text) as T
  } catch {
    throw new Error("the API returned an unparseable JSON response")
  }
}

// ---------------------------------------------------------------------------
// Output hygiene (copied from linkedin-search/helpers.ts)
// ---------------------------------------------------------------------------

const INVISIBLE_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFE00-\uFE0F\uFEFF\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu

/** Strip control, bidi, zero-width, variation-selector and tag characters recursively. */
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

/** Drop comments, script/style/template blocks and elements hidden by markup. */
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

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  oslash: "ø",
  Oslash: "Ø",
  aring: "å",
  Aring: "Å",
  aelig: "æ",
  AElig: "Æ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  copy: "©",
  reg: "®",
  deg: "°",
  middot: "·",
  times: "×",
}

function numericEntity(cp: number): string {
  return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ""
}

/** Decode HTML entities in one pass so `&amp;lt;` becomes `&lt;`, not `<`. */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9A-Fa-f]+|[a-zA-Z][a-zA-Z0-9]+);/g, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      return numericEntity(parseInt(body.slice(2), 16))
    }
    if (body.startsWith("#")) {
      return numericEntity(parseInt(body.slice(1), 10))
    }
    return NAMED_ENTITIES[body] ?? match
  })
}

/** HTML → readable text, preserving paragraph and line breaks. */
export function htmlToText(html: string): string {
  const withBreaks = visibleHtml(html)
    .replace(/\r\n?/g, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|ul|ol|h[1-6]|tr|table|section|article|blockquote)>/gi, "\n")
  const lines = withBreaks.split("\n").map((line) =>
    decodeHtmlEntities(line.replace(/<[^>]+>/g, ""))
      .replace(/[ \t\f\v]+/g, " ")
      .trim(),
  )
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()
}

// ---------------------------------------------------------------------------
// Registry and commute-area data
// ---------------------------------------------------------------------------

export interface Employer {
  row: number
  orgnr: string
  name: string
  aliases: string[]
  trdStaff: string
  nace: string
  website: string
  careerUrl: string
  ats: string
  atsRef: string
  confidence: string
  enabled: boolean
}

export interface Area {
  name?: string
  default?: string
  municipalities: Array<{
    code: string
    name: string
    aliases?: string[]
    places?: string[]
    postal_prefixes?: string[]
  }>
}

function findRepoRoot(): string | null {
  let dir = import.meta.dir
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "job_scraper")) || existsSync(join(dir, "trondheim-patches"))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function dataDir(): string | null {
  const env = process.env.JOB_SCRAPER_DIR
  if (env) return env
  const root = findRepoRoot()
  return root ? join(root, "job_scraper") : null
}

export function registryPath(): string {
  const dir = dataDir()
  const candidates = dir
    ? [join(dir, "employers.csv")]
    : []
  const root = findRepoRoot()
  if (root) candidates.push(join(root, "trondheim-patches", "employers.seed.csv"))
  for (const p of candidates) if (existsSync(p)) return p
  throw new Error(
    "employers registry not found; expected job_scraper/employers.csv (or trondheim-patches/employers.seed.csv)",
  )
}

export function areaPath(): string {
  const dir = dataDir()
  const p = dir ? join(dir, "area.json") : null
  if (p && existsSync(p)) return p
  throw new Error("commute-area file not found; expected job_scraper/area.json")
}

/** Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
      continue
    }
    if (c === '"') {
      inQuotes = true
    } else if (c === ",") {
      row.push(field)
      field = ""
    } else if (c === "\n") {
      row.push(field)
      rows.push(row)
      row = []
      field = ""
    } else if (c !== "\r") {
      field += c
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

export function parseRegistryCsv(text: string): Employer[] {
  const rows = parseCsv(text)
  if (rows.length === 0) return []
  const header = rows[0].map((h) => h.trim().toLowerCase())
  const col = (name: string): number => header.indexOf(name)
  const idx = {
    orgnr: col("orgnr"),
    name: col("name"),
    aliases: col("aliases"),
    trdStaff: col("trd_staff"),
    nace: col("nace"),
    website: col("website"),
    careerUrl: col("career_url"),
    ats: col("ats"),
    atsRef: col("ats_ref"),
    confidence: col("confidence"),
    enabled: col("enabled"),
  }
  if (idx.name === -1 || idx.ats === -1) return []
  const cell = (r: string[], i: number): string => (i >= 0 ? (r[i] ?? "").trim() : "")
  const employers: Employer[] = []
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    if (row.every((v) => v.trim() === "")) continue
    const enabledRaw = cell(row, idx.enabled).toLowerCase()
    employers.push({
      row: r + 1,
      orgnr: cell(row, idx.orgnr),
      name: cell(row, idx.name),
      aliases: cell(row, idx.aliases).split("|").map((s) => s.trim()).filter(Boolean),
      trdStaff: cell(row, idx.trdStaff),
      nace: cell(row, idx.nace),
      website: cell(row, idx.website),
      careerUrl: cell(row, idx.careerUrl),
      ats: cell(row, idx.ats),
      atsRef: cell(row, idx.atsRef),
      confidence: cell(row, idx.confidence),
      enabled: ["true", "1", "yes", "y"].includes(enabledRaw),
    })
  }
  return employers
}

export function readRegistry(path = registryPath()): Employer[] {
  return parseRegistryCsv(readFileSync(path, "utf8"))
}

/** Enabled rows for one ATS key, in registry order. */
export function enabledEmployers(ats: string, path = registryPath()): Employer[] {
  return readRegistry(path).filter((e) => e.enabled && e.ats.toLowerCase() === ats.toLowerCase())
}

export function loadArea(path = areaPath()): Area {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Area
  if (!parsed || !Array.isArray(parsed.municipalities)) {
    throw new Error(`invalid commute-area file: ${path}`)
  }
  return parsed
}

// ---------------------------------------------------------------------------
// Location, date and paging helpers
// ---------------------------------------------------------------------------

/** Lowercase, remove diacritics and punctuation, collapse whitespace. */
export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/ø/g, "o")
    .replace(/æ/g, "ae")
    .replace(/å/g, "a")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

function containsTerm(haystack: string, needle: string): boolean {
  if (!needle) return false
  if (needle.length <= 4) {
    return new RegExp(`(?:^| )${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?: |$)`).test(haystack)
  }
  return haystack.includes(needle)
}

export interface LocationInfo {
  text: string | null
  city?: string | null
  country?: string | null
  postalCode?: string | null
}

export function locationMatches(info: LocationInfo, want: string | undefined, area: Area): boolean {
  if (!want) return true
  const wantNorm = normalizeText(want)
  if (!wantNorm) return true
  const hay = [info.city, info.text].filter((s): s is string => Boolean(s)).map(normalizeText)
  if (hay.length === 0 && !info.postalCode) return false

  const matchesArea = (): boolean => {
    for (const m of area.municipalities) {
      const names = [m.name, ...(m.aliases ?? []), ...(m.places ?? [])].map(normalizeText)
      if (hay.some((h) => names.some((n) => containsTerm(h, n)))) return true
      if (info.postalCode && (m.postal_prefixes ?? []).some((p) => info.postalCode?.startsWith(p))) {
        return true
      }
    }
    return false
  }

  if (wantNorm === "area" || wantNorm === "omradet" || wantNorm === "trondheimsomradet") {
    return matchesArea()
  }

  // A specific place: direct match against the posting's city/location text.
  if (hay.some((h) => containsTerm(h, wantNorm))) return true

  // If the requested place is a municipality or one of its places, match any
  // posting located in that municipality (e.g. -l Trondheim matches Heimdal).
  for (const m of area.municipalities) {
    const names = [m.name, ...(m.aliases ?? []), ...(m.places ?? [])].map(normalizeText)
    if (!names.includes(wantNorm)) continue
    if (hay.some((h) => names.some((n) => containsTerm(h, n)))) return true
  }
  return false
}

/** ISO/RFC date string → YYYY-MM-DD (UTC), or null when unparseable. */
export function parseDate(value: string | null | undefined): string | null {
  if (!value) return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString().slice(0, 10)
}

/** Calendar-day age check. An unknown date cannot prove freshness, so it is dropped. */
export function withinJobAge(date: string | null, days: number | undefined, now = Date.now()): boolean {
  if (days === undefined || days === null) return true
  if (!date) return false
  const jobDay = Date.parse(`${date}T00:00:00Z`)
  if (Number.isNaN(jobDay)) return false
  const today = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`)
  return (today - jobDay) / 86_400_000 <= days
}

export function paginate<T>(items: T[], page: number, limit: number | undefined): T[] {
  const size = limit && limit > 0 ? limit : DEFAULT_LIMIT
  const start = (Math.max(1, page) - 1) * size
  return items.slice(start, start + size)
}

// ---------------------------------------------------------------------------
// SmartRecruiters API shapes
// ---------------------------------------------------------------------------

export interface SRPosting {
  id: string
  name: string
  refNumber?: string
  releasedDate?: string
  company?: { identifier?: string; name?: string }
  location?: {
    city?: string
    region?: string
    country?: string
    address?: string
    postalCode?: string
    remote?: boolean
    hybrid?: boolean
    fullLocation?: string
  }
}

export interface SRPostingsResponse {
  offset: number
  limit: number
  totalFound: number
  content: SRPosting[]
}

export interface SRDetail extends SRPosting {
  postingUrl?: string
  applyUrl?: string
  jobAd?: { sections?: Record<string, { title?: string; text?: string } | undefined> }
}

export interface JobResult {
  id: string
  title: string
  company: string | null
  location: string | null
  date: string | null
  url: string
}

export interface LocationMapped {
  result: JobResult
  loc: LocationInfo
}

export function parseSlug(ref: string): string | null {
  const trimmed = ref.trim()
  if (!trimmed) return null
  const urlMatch = trimmed.match(/\/companies\/([^/?#]+)/i)
  if (urlMatch) return decodeURIComponent(urlMatch[1])
  const kv = trimmed.match(/^(?:slug|company|companyIdentifier)=(.+)$/i)
  if (kv) return kv[1].trim()
  return /^[A-Za-z0-9._-]+$/.test(trimmed) ? trimmed : null
}

/**
 * Registry rows whose ats_ref is wrong but whose real slug has been verified
 * live (Nov 2026). Keyed by the registry display name. Anything not listed is
 * used as-is, and `v1`-style API versions are rejected instead of guessed.
 */
export const SLUG_OVERRIDES: Record<string, string> = {
  "SPORTRADAR AS": "Sportradar",
}

export function resolveSlug(employer: Employer): string {
  const override = SLUG_OVERRIDES[employer.name.trim().toUpperCase()]
  const slug = override ?? parseSlug(employer.atsRef)
  if (!slug) {
    throw new Error(`registry ats_ref ${JSON.stringify(employer.atsRef)} is not a SmartRecruiters company slug`)
  }
  if (/^v\d+$/i.test(slug)) {
    throw new Error(
      `registry ats_ref ${JSON.stringify(employer.atsRef)} is the API version, not a SmartRecruiters company slug`,
    )
  }
  return slug
}

export function displayLocation(loc: SRPosting["location"]): string | null {
  if (!loc) return null
  if (loc.fullLocation?.trim()) {
    // SmartRecruiters emits e.g. "Trondheim, , Norway" when the region is
    // empty; drop the blank component instead of displaying a double comma.
    const cleaned = loc.fullLocation
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .join(", ")
    if (cleaned) return cleaned
  }
  const parts = [loc.city, loc.region, loc.country].filter((s): s is string => Boolean(s && s.trim()))
  return parts.length > 0 ? parts.join(", ") : null
}

export function mapPosting(item: SRPosting, employer: Employer, slug: string): LocationMapped {
  const location = displayLocation(item.location)
  return {
    result: {
      id: String(item.id),
      title: item.name?.trim() || "(untitled)",
      company: employer.name || null,
      location,
      date: parseDate(item.releasedDate),
      url: `${jobsBase()}/${encodeURIComponent(slug)}/${encodeURIComponent(String(item.id))}`,
    },
    loc: {
      text: location,
      city: item.location?.city ?? null,
      country: item.location?.country ?? null,
      postalCode: item.location?.postalCode ?? null,
    },
  }
}

export function postingsUrl(slug: string, offset: number, limit: number, query?: string, country?: string): string {
  const params = new URLSearchParams()
  params.set("limit", String(limit))
  params.set("offset", String(offset))
  if (query) params.set("q", query)
  if (country) params.set("country", country)
  return `${apiBase()}/v1/companies/${encodeURIComponent(slug)}/postings?${params.toString()}`
}

export function detailUrl(slug: string, id: string): string {
  return `${apiBase()}/v1/companies/${encodeURIComponent(slug)}/postings/${encodeURIComponent(id)}`
}

/** Concatenate the readable job-ad sections in a stable order. */
export function parseDetailDescription(detail: SRDetail): string | null {
  const sections = detail.jobAd?.sections
  if (!sections || typeof sections !== "object") return null
  const preferred = ["companyDescription", "jobDescription", "qualifications", "additionalInformation"]
  const keys = [
    ...preferred.filter((k) => sections[k]),
    ...Object.keys(sections).filter((k) => !preferred.includes(k)),
  ]
  const blocks: string[] = []
  for (const key of keys) {
    const section = sections[key]
    if (!section) continue
    const body = section.text ? htmlToText(section.text) : ""
    const title = section.title ? htmlToText(section.title) : ""
    if (body) blocks.push(title ? `${title}\n\n${body}` : body)
    else if (title) blocks.push(title)
  }
  return blocks.length > 0 ? blocks.join("\n\n") : null
}

export interface JobDetail extends JobResult {
  description: string | null
  refNumber: string | null
  department: string | null
  employmentType: string | null
  industry: string | null
}

export function mapDetail(detail: SRDetail, employerName?: string | null, slug?: string): JobDetail {
  const location = displayLocation(detail.location)
  return {
    id: String(detail.id),
    title: detail.name?.trim() || "(untitled)",
    company: employerName || detail.company?.name || null,
    location,
    date: parseDate(detail.releasedDate),
    url:
      detail.postingUrl ||
      (slug ? `${jobsBase()}/${encodeURIComponent(slug)}/${encodeURIComponent(String(detail.id))}` : ""),
    description: parseDetailDescription(detail),
    refNumber: detail.refNumber ?? null,
    department: (detail as unknown as { department?: { label?: string } }).department?.label ?? null,
    employmentType:
      (detail as unknown as { typeOfEmployment?: { label?: string } }).typeOfEmployment?.label ?? null,
    industry: (detail as unknown as { industry?: { label?: string } }).industry?.label ?? null,
  }
}

export interface DetailInput {
  slug: string | null
  id: string
}

/** Accept a posting ID, a public jobs.smartrecruiters.com URL or an API URL. */
export function normalizeDetailInput(input: string): DetailInput | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  if (/^\d{6,}$/.test(trimmed)) return { slug: null, id: trimmed }

  const kv = trimmed.match(/^([A-Za-z0-9._-]+)[:/]([A-Za-z0-9-]+)$/)
  if (kv && !/^https?$/i.test(kv[1])) return { slug: kv[1], id: kv[2] }

  const hasScheme = /^https?:\/\//i.test(trimmed)
  if (hasScheme || /^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(trimmed)) {
    let parsed: URL
    try {
      parsed = new URL(hasScheme ? trimmed : `https://${trimmed}`)
    } catch {
      return null
    }
    const host = parsed.hostname.toLowerCase()
    if (host === "jobs.smartrecruiters.com") {
      const m = parsed.pathname.match(/^\/([^/]+)\/(\d+)(?:[-/].*)?$/)
      return m ? { slug: m[1], id: m[2] } : null
    }
    if (host === "api.smartrecruiters.com") {
      const m = parsed.pathname.match(/^\/v1\/companies\/([^/]+)\/postings\/(\d+)(?:\/.*)?$/)
      return m ? { slug: m[1], id: m[2] } : null
    }
    return null
  }
  return null
}
