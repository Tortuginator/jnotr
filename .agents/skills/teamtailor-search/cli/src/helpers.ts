// Teamtailor public RSS feeds + posting pages.
//
// Zero runtime dependencies: Bun's fetch plus regex parsing. The RSS export is a
// stable, documented feed (`<site>/jobs.rss`) with a `tt:` locations namespace, so
// a DOM parser would add weight without buying robustness.

import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

export const UA = "Mozilla/5.0 (compatible; teamtailor-search-cli/1.0)"
export const PER_PAGE = 100

export function writeError(error: string, code: string): void {
  process.stderr.write(JSON.stringify(stripInvisible({ error, code })) + "\n")
}

// ---------------------------------------------------------------------------
// Fetching

/**
 * Fetch HTML/XML with exponential backoff and jitter on 429/5xx. Returns "" on a
 * 404 (a missing feed is an empty feed; a missing posting is NOT_FOUND upstream).
 */
export async function htmlFetch(url: string): Promise<string> {
  const maxRetries = 6
  let delay = 500
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response: Response
    try {
      response = await fetch(url, {
        headers: {
          "User-Agent": UA,
          Accept: "application/rss+xml,application/xml,text/xml,text/html;q=0.9,*/*;q=0.8",
          "Accept-Language": "nb-NO,nb;q=0.9,en;q=0.8",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(15000),
      })
    } catch (e) {
      if (attempt === maxRetries) throw e
      await sleep(delay + jitter())
      delay = Math.min(delay * 2, 8000)
      continue
    }
    if (response.status === 429 || response.status >= 500) {
      if (attempt === maxRetries) {
        throw new Error(`Request failed: ${response.status} ${response.statusText}`)
      }
      await sleep(delay + jitter())
      delay = Math.min(delay * 2, 8000)
      continue
    }
    if (response.status === 404) return ""
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status} ${response.statusText}`)
    }
    return response.text()
  }
  throw new Error("Request failed after max retries")
}

function jitter(): number {
  return Math.floor(Math.random() * 500)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Offline tests point this at a fixture directory. When set, no request leaves
// the machine: feed pages are read as `<slug>.rss` / `<slug>.<offset>.rss`, and a
// posting page as `<last-path-segment>.html` or `detail.html`.
function fixtureDir(): string | null {
  const dir = process.env.TEAMTAILOR_FIXTURE_DIR?.trim()
  return dir ? dir : null
}

function readFixture(name: string): string | null {
  const dir = fixtureDir()
  if (!dir) return null
  const path = join(dir, name)
  if (!existsSync(path)) return null
  return readFileSync(path, "utf8")
}

function fixtureSlug(url: string): string {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.replace(/^www\./i, "")
    if (/\.teamtailor\.com$/i.test(host)) return host.replace(/\.teamtailor\.com$/i, "")
    return host
  } catch {
    return url
  }
}

function sanitizeFixtureName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_")
}

/** Build a feed page URL, preserving any query already present in `ats_ref`. */
export function feedPageUrl(base: string, offset: number, perPage = PER_PAGE): string {
  const url = new URL(base)
  url.searchParams.set("offset", String(offset))
  url.searchParams.set("per_page", String(perPage))
  return url.toString()
}

export interface FeedPage {
  items: FeedItem[]
  /** True when the page was short (or empty), meaning the feed is exhausted. */
  exhausted: boolean
}

/**
 * Fetch one RSS page. A 404 becomes an empty exhausted page. Fixture mode reads
 * `<slug>.rss` for offset 0 and `<slug>.<offset>.rss` afterwards; a missing
 * fixture throws so the caller can record it in meta.errors.
 */
export async function fetchFeedPage(base: string, offset: number): Promise<FeedPage> {
  const url = feedPageUrl(base, offset)
  const dir = fixtureDir()
  if (dir) {
    const slug = sanitizeFixtureName(fixtureSlug(base))
    const name = offset === 0 ? `${slug}.rss` : `${slug}.${offset}.rss`
    const text = readFixture(name)
    if (text === null) throw new Error(`fixture not found: ${name}`)
    const items = parseFeed(text)
    return { items, exhausted: items.length < PER_PAGE }
  }
  const text = await htmlFetch(url)
  if (!text) return { items: [], exhausted: true }
  const items = parseFeed(text)
  return { items, exhausted: items.length < PER_PAGE }
}

/** Fetch a posting page. In fixture mode `detail.html` is the shared sample. */
export async function fetchPosting(url: string): Promise<string> {
  const dir = fixtureDir()
  if (dir) {
    let segment = ""
    try {
      const parts = new URL(url).pathname.split("/").filter(Boolean)
      segment = parts.length ? decodeURIComponent(parts[parts.length - 1]) : ""
    } catch {
      segment = ""
    }
    if (segment) {
      const specific = readFixture(`${sanitizeFixtureName(segment)}.html`)
      if (specific !== null) return specific
    }
    return readFixture("detail.html") ?? ""
  }
  return htmlFetch(url)
}

// ---------------------------------------------------------------------------
// HTML hygiene (copied from linkedin-search/cli/src/helpers.ts, the canonical
// implementation of this output boundary)

/**
 * Characters a reader of the posting never sees but a model reading this output
 * does: C0/C1 controls other than tab/newline/CR, soft hyphen, bidi marks,
 * zero-width characters, BOM, variation selectors, and Unicode tag characters.
 */
const INVISIBLE_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFE00-\uFE0F\uFEFF\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu

/** Strip INVISIBLE_CHARS from every string in a result, recursively. */
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

/**
 * Drop markup a browser never renders (comments, script/style/template blocks,
 * hidden elements) before tags are stripped, so hidden instructions never reach
 * the model as visible text.
 */
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

/** Extract the inner HTML of the first element whose class contains `className`. */
export function extractDivContent(html: string, className: string): string | null {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const openRe = new RegExp(`<div[^>]*class="[^"]*${escaped}[^"]*"[^>]*>`, "i")
  const open = openRe.exec(html)
  if (!open) return null

  let i = open.index + open[0].length
  let depth = 1
  while (depth > 0 && i < html.length) {
    const nextOpen = html.indexOf("<div", i)
    const nextClose = html.indexOf("</div>", i)
    if (nextClose === -1) return null
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++
      i = nextOpen + 4
    } else {
      depth--
      i = nextClose + 6
    }
  }
  return html.slice(open.index + open[0].length, i - 6)
}

// ---------------------------------------------------------------------------
// RSS parsing

export interface RawLocation {
  name: string | null
  address: string | null
  zip: string | null
  city: string | null
  country: string | null
}

export interface FeedItem {
  title: string | null
  description: string | null
  pubDate: string | null
  link: string | null
  guid: string | null
  remoteStatus: string | null
  department: string | null
  role: string | null
  locations: RawLocation[]
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function xmlText(chunk: string, tag: string): string | null {
  const re = new RegExp(`<${escapeRe(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapeRe(tag)}\\s*>`, "i")
  const m = chunk.match(re)
  if (!m) return null
  let value = m[1].trim()
  const cdata = value.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/)
  if (cdata) value = cdata[1]
  value = decodeHtmlEntities(value).trim()
  return value || null
}

function parseLocations(chunk: string): RawLocation[] {
  const block = chunk.match(/<tt:locations\b[^>]*>([\s\S]*?)<\/tt:locations>/i)?.[1]
  if (!block) return []
  const locations: RawLocation[] = []
  for (const match of block.matchAll(/<tt:location\b[^>]*>([\s\S]*?)<\/tt:location>/gi)) {
    const loc = match[1]
    const location: RawLocation = {
      name: xmlText(loc, "tt:name"),
      address: xmlText(loc, "tt:address"),
      zip: xmlText(loc, "tt:zip"),
      city: xmlText(loc, "tt:city"),
      country: xmlText(loc, "tt:country"),
    }
    if (location.name || location.city || location.zip) locations.push(location)
  }
  return locations
}

/** Parse an RSS 2.0 Teamtailor jobs feed. Chunks are parsed independently. */
export function parseFeed(xml: string): FeedItem[] {
  const items: FeedItem[] = []
  for (const match of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const chunk = match[1]
    items.push({
      title: xmlText(chunk, "title"),
      description: xmlText(chunk, "description"),
      pubDate: xmlText(chunk, "pubDate"),
      link: xmlText(chunk, "link"),
      guid: xmlText(chunk, "guid"),
      remoteStatus: xmlText(chunk, "remoteStatus"),
      department: xmlText(chunk, "tt:department"),
      role: xmlText(chunk, "tt:role"),
      locations: parseLocations(chunk),
    })
  }
  return items
}

export function lastPathSegment(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean)
    return parts.length ? decodeURIComponent(parts[parts.length - 1]) : null
  } catch {
    return null
  }
}

export function toIsoDate(value: string | null | undefined): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString().slice(0, 10)
}

function countryName(value: string | null): string | null {
  if (!value) return null
  const code = value.trim().toUpperCase()
  const names: Record<string, string> = {
    NO: "Norway", NOR: "Norway", NORGE: "Norway",
    SE: "Sweden", SWE: "Sweden", SVERIGE: "Sweden",
    DK: "Denmark", DNK: "Denmark", DANMARK: "Denmark",
    FI: "Finland", FIN: "Finland", SUOMI: "Finland",
  }
  return names[code] ?? value.trim()
}

/** `name` (or `city`) plus country, joined with "; " for multiple locations. */
export function formatLocations(locations: RawLocation[]): string | null {
  const parts: string[] = []
  for (const loc of locations) {
    const place = loc.name || loc.city
    if (!place) continue
    const country = countryName(loc.country)
    const formatted = country ? `${place}, ${country}` : place
    if (!parts.includes(formatted)) parts.push(formatted)
  }
  return parts.length ? parts.join("; ") : null
}

// ---------------------------------------------------------------------------
// Location matching

/** Lower-case, diacritic-tolerant, whitespace-collapsed form for comparisons. */
export function normalizeLocation(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/ø/g, "o")
    .replace(/æ/g, "ae")
    .replace(/ß/g, "ss")
    .replace(/\s+/g, " ")
    .trim()
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

function zipMatches(zip: string | null, prefixes: string[] | undefined): boolean {
  if (!zip || !prefixes?.length) return false
  const digits = zip.replace(/\D/g, "")
  if (!digits) return false
  return prefixes.some((prefix) => {
    const wanted = prefix.replace(/\D/g, "")
    return wanted.length > 0 && digits.startsWith(wanted)
  })
}

function locationNames(loc: RawLocation): string[] {
  return [loc.name, loc.city].filter((v): v is string => Boolean(v))
}

/**
 * Area place names repeat abroad (Trondheim's `Lund` vs Lund, Sweden), so a
 * location that explicitly names a non-Norwegian country cannot be in the
 * commute area. A missing country is allowed: some feeds omit it.
 */
function isNorwegianCountry(country: string | null): boolean {
  if (!country) return true
  return ["norway", "norge", "no", "nor"].includes(normalizeLocation(country))
}

export function matchesArea(locations: RawLocation[], area: AreaFile): boolean {
  for (const loc of locations) {
    if (!isNorwegianCountry(loc.country)) continue
    const names = locationNames(loc).map(normalizeLocation)
    for (const municipality of area.municipalities) {
      const candidates = [
        municipality.name,
        ...(municipality.aliases ?? []),
        ...(municipality.places ?? []),
      ].map(normalizeLocation)
      if (names.some((n) => candidates.includes(n))) return true
      if (zipMatches(loc.zip, municipality.postal_prefixes)) return true
    }
  }
  return false
}

/** Match a specific place against location `name` or `city`. */
export function matchesPlace(locations: RawLocation[], place: string): boolean {
  const wanted = normalizeLocation(place)
  if (!wanted) return true
  return locations.some((loc) => locationNames(loc).some((name) => normalizeLocation(name) === wanted))
}

export function isWithinDays(pubDate: string | null, days: number, now = Date.now()): boolean {
  if (!pubDate) return false
  const time = new Date(pubDate).getTime()
  if (Number.isNaN(time)) return false
  return time >= now - days * 86_400_000
}

// ---------------------------------------------------------------------------
// Registry

export interface Employer {
  name: string
  feedUrl: string
  orgnr: string | null
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

/** Locate job_scraper/employers.csv, falling back to the seed registry. */
export function resolveRegistryPath(): string | null {
  const override = process.env.TEAMTAILOR_REGISTRY?.trim()
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
  const override = process.env.TEAMTAILOR_AREA?.trim()
  if (override) return existsSync(override) ? override : null
  const roots = [...ancestorDirs(process.cwd()), ...ancestorDirs(import.meta.dir)]
  return firstExisting(roots.map((root) => join(root, "job_scraper", "area.json")))
}

function normalizeFeedUrl(ref: string): string | null {
  const raw = ref.trim()
  if (!raw) return null
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  try {
    const url = new URL(withScheme)
    if (url.protocol !== "https:" && url.protocol !== "http:") return null
    if (!/\.rss$/i.test(url.pathname)) return null
    url.hash = ""
    return url.toString()
  } catch {
    return null
  }
}

function isEnabled(value: string | undefined): boolean {
  if (value === undefined) return true
  const normalized = value.trim().toLowerCase()
  return !["false", "0", "no", "nei", "disabled", "off"].includes(normalized)
}

function cell(row: string[], header: string[], name: string): string {
  const index = header.indexOf(name)
  return index === -1 ? "" : (row[index] ?? "").trim()
}

/**
 * Normalise registry rows into Teamtailor employers. Missing `ats_ref` rows are
 * skipped and reported, never guessed. Disabled and non-Teamtailor rows are
 * ignored silently.
 */
export function normalizeRegistry(text: string, source = "registry"): Registry {
  const rows = parseCsv(text)
  if (rows.length === 0) {
    return { employers: [], errors: [], source }
  }
  const header = rows[0].map((h) => h.trim().toLowerCase())
  const employers: Employer[] = []
  const errors: RegistryError[] = []
  const seenFeeds = new Set<string>()

  for (const row of rows.slice(1)) {
    if (cell(row, header, "ats").toLowerCase() !== "teamtailor") continue
    if (!isEnabled(cell(row, header, "enabled"))) continue

    const name = cell(row, header, "name") || cell(row, header, "orgnr") || "Unknown employer"
    const ref = cell(row, header, "ats_ref")
    if (!ref) {
      errors.push({ employer: name, error: "missing ats_ref; employer skipped" })
      continue
    }
    const feedUrl = normalizeFeedUrl(ref)
    if (!feedUrl) {
      errors.push({ employer: name, error: `invalid ats_ref (not a Teamtailor RSS feed): ${ref}` })
      continue
    }
    const dedupeKey = feedPageUrl(feedUrl, 0).toLowerCase()
    if (seenFeeds.has(dedupeKey)) continue
    seenFeeds.add(dedupeKey)
    employers.push({ name, feedUrl, orgnr: cell(row, header, "orgnr") || null })
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
// Detail parsing

export interface JobDetail {
  id: string | null
  title: string | null
  company: string | null
  location: string | null
  date: string | null
  url: string
  description: string | null
}

function jsonLdObjects(html: string): any[] {
  const objects: any[] = []
  for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(match[1].trim())
      if (Array.isArray(parsed)) objects.push(...parsed)
      else if (parsed && typeof parsed === "object") {
        if (Array.isArray(parsed["@graph"])) objects.push(...parsed["@graph"])
        else objects.push(parsed)
      }
    } catch {
      // One malformed block must not hide the others.
    }
  }
  return objects
}

function jsonLdJobPosting(html: string): any | null {
  for (const object of jsonLdObjects(html)) {
    const type = object?.["@type"]
    if (type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"))) return object
  }
  return null
}

function jsonLdLocations(jobLocation: any): RawLocation[] {
  if (!jobLocation) return []
  const places = Array.isArray(jobLocation) ? jobLocation : [jobLocation]
  const locations: RawLocation[] = []
  for (const place of places) {
    const address = place?.address ?? place
    if (!address || typeof address !== "object") continue
    const city = typeof address.addressLocality === "string" ? address.addressLocality : null
    const country = typeof address.addressCountry === "string" ? address.addressCountry : null
    const zip = typeof address.postalCode === "string" ? address.postalCode : null
    if (city || country || zip) {
      locations.push({ name: city, city, zip, country, address: null })
    }
  }
  return locations
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return null
}

function metaContent(html: string, property: string): string | null {
  const re = new RegExp(
    `<meta[^>]*(?:property|name)\\s*=\\s*["']${escapeRe(property)}["'][^>]*content\\s*=\\s*["']([^"']*)["'][^>]*>`,
    "i",
  )
  const direct = html.match(re)?.[1]
  if (direct) return decodeHtmlEntities(direct)
  const reversed = new RegExp(
    `<meta[^>]*content\\s*=\\s*["']([^"']*)["'][^>]*(?:property|name)\\s*=\\s*["']${escapeRe(property)}["'][^>]*>`,
    "i",
  )
  const other = html.match(reversed)?.[1]
  return other ? decodeHtmlEntities(other) : null
}

export function parseDetail(html: string, url: string): JobDetail {
  const posting = jsonLdJobPosting(html)

  const ldTitle = posting ? firstString(posting.title) : null
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? null
  const documentTitle = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? null
  const title = cleanInline(ldTitle) ?? cleanInline(h1) ?? cleanInline(documentTitle?.split(/\s+[-|–]\s+/)[0] ?? null)

  const organization = posting?.hiringOrganization
  const company =
    cleanInline(typeof organization === "string" ? organization : organization?.name) ??
    cleanInline(metaContent(html, "og:site_name")) ??
    cleanInline(documentTitle?.split(/\s+[-|–]\s+/).slice(1).join(" - ") ?? null)

  const locations = posting ? jsonLdLocations(posting.jobLocation) : []
  let location = formatLocations(locations)
  if (!location) {
    // Fallback for markup drift: the "Steder" links point at /locations/<slug>.
    const names: string[] = []
    for (const match of html.matchAll(/<a\b[^>]*href=["'][^"']*\/locations\/[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const name = cleanInline(match[1])
      if (name && !names.includes(name)) names.push(name)
    }
    location = names.length ? names.join("; ") : null
  }

  const date =
    toIsoDate(firstString(posting?.datePosted)) ??
    toIsoDate(metaContent(html, "article:published_time")) ??
    toIsoDate(metaContent(html, "og:article:published_time"))

  const descriptionHtml =
    (posting && firstString(posting.description)) ??
    extractDivContent(html, "prose") ??
    null
  const description = htmlToText(descriptionHtml)

  const identifier = posting?.identifier
  const identifierValue =
    typeof identifier === "string"
      ? identifier
      : typeof identifier?.value === "string"
        ? identifier.value
        : null

  return {
    id: identifierValue ?? lastPathSegment(url),
    title,
    company,
    location,
    date,
    url: metaContent(html, "og:url") ?? url,
    description,
  }
}
