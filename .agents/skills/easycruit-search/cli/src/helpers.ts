// Data source: Visma EasyCruit public career sites.
//
// Verified live 6 November 2026:
//   https://<slug>.easycruit.com/rss
//   https://<slug>.easycruit.com/export/xml/vacancy/list.xml
//   https://<slug>.easycruit.com/export/xml/vacancy/<id>.xml
//   https://<slug>.easycruit.com/vacancy/<id>/rss   (public HTML detail)
//
// The RSS feed is public and has descriptions, but every <link> in it points at
// the same (first) vacancy on the sites checked. It therefore cannot supply
// per-posting IDs. The XML joblist is public, returns one <Vacancy id="..."> per
// posting, and is the source of IDs and dates. RSS descriptions are joined back
// by title; the HTML detail page supplies the workplace shown as .jd-location.
//
// Zero runtime dependencies: Bun + fetch + regex.

import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

export const UA = "Mozilla/5.0 (compatible; easycruit-search-cli/1.0)"
export const DEFAULT_LIMIT = 50
export const DEFAULT_DETAIL_LIMIT = 40

const HTML_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
const XML_ACCEPT = "application/xml,application/rss+xml,text/xml;q=0.9,*/*;q=0.8"

export function writeError(error: string, code: string): void {
  process.stderr.write(JSON.stringify(stripInvisible({ error, code })) + "\n")
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function jitter(): number {
  return Math.floor(Math.random() * 500)
}

// ---------------------------------------------------------------------------
// Fetching (with offline fixture mode)

export interface FetchLike {
  (input: string | URL, init?: RequestInit): Promise<Response>
}

export interface TextResponse {
  status: number
  ok: boolean
  statusText: string
  text: string
}

function fixtureDir(): string | null {
  const dir = process.env.EASYCRUIT_FIXTURE_DIR?.trim()
  return dir ? dir : null
}

function readFixture(dir: string, name: string): string | null {
  const path = join(dir, name)
  return existsSync(path) ? readFileSync(path, "utf8") : null
}

export function slugFromHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "").split(".")[0]
}

function sanitizeFixtureName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_")
}

function fixtureNamesFor(url: string): string[] {
  const parsed = new URL(url)
  const slug = sanitizeFixtureName(slugFromHost(parsed.hostname))
  const path = parsed.pathname
  const names: string[] = []

  if (/\/export\/xml\/vacancy\/list\.xml$/i.test(path)) {
    names.push(`${slug}.list.xml`, "list.xml")
  } else {
    const html = path.match(/^\/vacancy\/(\d+)\/rss$/i)
    if (html) {
      names.push(`${slug}.${html[1]}.html`, `${html[1]}.html`, "detail.html")
    }
    const xml = path.match(/^\/export\/xml\/vacancy\/(\d+)\.xml$/i)
    if (xml) {
      names.push(`${slug}.${xml[1]}.xml`, `${xml[1]}.xml`, "detail.xml")
    }
    if (names.length === 0 && /\/rss$/i.test(path)) {
      names.push(`${slug}.rss`, "feed.rss")
    }
  }
  return names
}

function fixtureResponse(url: string): TextResponse | null {
  const dir = fixtureDir()
  if (!dir) return null
  for (const name of fixtureNamesFor(url)) {
    const text = readFixture(dir, name)
    if (text !== null) return { status: 200, ok: true, statusText: "OK", text }
  }
  // Fixture mode must never fall through to the network. A missing fixture is
  // the same as the server's 404.
  return { status: 404, ok: false, statusText: "Not Found", text: "" }
}

/**
 * Fetch text with exponential backoff and jitter on 429/5xx/connection errors.
 * A 404 is returned so callers can treat it as an empty feed / missing posting.
 * A 202 is EasyCruit's AWS WAF JavaScript challenge; it is reported, never
 * solved or bypassed.
 */
export async function fetchTextRaw(
  url: string,
  accept: string,
  fetchImpl: FetchLike = fetch,
): Promise<TextResponse> {
  const fixture = fixtureResponse(url)
  if (fixture) return fixture

  const maxRetries = 6
  let delay = 500
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response: Response
    try {
      response = await fetchImpl(url, {
        headers: {
          "User-Agent": UA,
          Accept: accept,
          "Accept-Language": "nb-NO,nb;q=0.9,en;q=0.8",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(15000),
      })
    } catch (error) {
      if (attempt === maxRetries) {
        throw new Error(`could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`)
      }
      await sleep(delay + jitter())
      delay = Math.min(delay * 2, 8000)
      continue
    }
    if (response.status === 429 || response.status >= 500) {
      if (attempt === maxRetries) {
        throw new Error(`request failed: ${response.status} ${response.statusText}`)
      }
      await sleep(delay + jitter())
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

/** Fetch a feed/page. Returns "" on 404. Throws on WAF challenges and other errors. */
export async function fetchText(
  url: string,
  accept: string,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const response = await fetchTextRaw(url, accept, fetchImpl)
  if (response.status === 404) return ""
  if (response.status === 202) {
    throw new Error(
      `EasyCruit returned an AWS WAF challenge (HTTP 202) for ${url}; this CLI does not bypass the challenge`,
    )
  }
  if (!response.ok) {
    throw new Error(`request failed: ${response.status} ${response.statusText}`)
  }
  return response.text
}

export function fetchHtml(url: string, fetchImpl: FetchLike = fetch): Promise<string> {
  return fetchText(url, HTML_ACCEPT, fetchImpl)
}

export function fetchXml(url: string, fetchImpl: FetchLike = fetch): Promise<string> {
  return fetchText(url, XML_ACCEPT, fetchImpl)
}

// ---------------------------------------------------------------------------
// Output hygiene (copied from linkedin-search/cli/src/helpers.ts, the canonical
// implementation of this output boundary)

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

/** Decode HTML/XML entities in one pass so `&amp;lt;` becomes `&lt;`, not `<`. */
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

/** Visible text of an inline HTML/XML fragment, entities decoded, whitespace collapsed. */
export function cleanInline(html: string | null | undefined): string | null {
  if (!html) return null
  const text = decodeHtmlEntities(visibleHtml(html).replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
  return text || null
}

function htmlToTextInternal(html: string | null | undefined, decodeEntities: boolean): string | null {
  if (!html) return null
  const withBreaks = visibleHtml(html)
    .replace(/\r\n?/g, "\n")
    .replace(/\s+/g, " ")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|ul|ol|div|h[1-6]|tr|table|section|article|blockquote)>/gi, "\n")
  const text = withBreaks
    .split("\n")
    .map((line) => {
      const stripped = line.replace(/<[^>]+>/g, " ")
      const decoded = decodeEntities ? decodeHtmlEntities(stripped) : stripped
      return decoded.replace(/[ \t]+/g, " ").trim()
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return text || null
}

/** HTML → readable text, preserving paragraph and line breaks. */
export function htmlToText(html: string | null | undefined): string | null {
  return htmlToTextInternal(html, true)
}

/**
 * HTML that was already entity-decoded once from XML → readable text. Entities
 * are not decoded a second time, so `&amp;lt;` (decoded to `&lt;`) stays escaped
 * instead of turning into a literal tag.
 */
export function htmlToTextDecoded(html: string | null | undefined): string | null {
  return htmlToTextInternal(html, false)
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

function metaContent(html: string, property: string): string | null {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const direct = html.match(
    new RegExp(`<meta[^>]*(?:property|name)\\s*=\\s*["']${escaped}["'][^>]*content\\s*=\\s*["']([^"']*)["'][^>]*>`, "i"),
  )?.[1]
  if (direct) return decodeHtmlEntities(direct)
  const reversed = html.match(
    new RegExp(`<meta[^>]*content\\s*=\\s*["']([^"']*)["'][^>]*(?:property|name)\\s*=\\s*["']${escaped}["'][^>]*>`, "i"),
  )?.[1]
  return reversed ? decodeHtmlEntities(reversed) : null
}

function labeledDiv(html: string, className: string): string | null {
  const inner = extractDivContent(html, className)
  if (!inner) return null
  const withoutHeading = inner.replace(/<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]>/gi, "")
  return cleanInline(withoutHeading)
}

// ---------------------------------------------------------------------------
// Registry and commute-area data

export interface Employer {
  name: string
  orgnr: string | null
  ats: string
  atsRef: string
  baseUrl: string
  slug: string
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

/** Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF, newlines in quotes). */
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
  const override = process.env.EASYCRUIT_REGISTRY?.trim()
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
  const override = process.env.EASYCRUIT_AREA?.trim()
  if (override) return existsSync(override) ? override : null
  const roots = [...ancestorDirs(process.cwd()), ...ancestorDirs(import.meta.dir)]
  return firstExisting(roots.map((root) => join(root, "job_scraper", "area.json")))
}

function cell(row: string[], header: string[], name: string): string {
  const index = header.indexOf(name)
  return index === -1 ? "" : (row[index] ?? "").trim()
}

function isEnabled(value: string | undefined): boolean {
  if (value === undefined) return true
  const normalized = value.trim().toLowerCase()
  return !["false", "0", "no", "nei", "disabled", "off"].includes(normalized)
}

/** Accept `https://x.easycruit.com`, `x.easycruit.com`, or a URL with a path. */
export function normalizeBaseUrl(ref: string): string | null {
  const raw = ref.trim()
  if (!raw) return null
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  try {
    const url = new URL(withScheme)
    if (url.protocol !== "https:" && url.protocol !== "http:") return null
    const host = url.hostname.toLowerCase()
    if (host !== "easycruit.com" && !host.endsWith(".easycruit.com")) return null
    const slug = slugFromHost(host)
    if (!slug || slug === "www" || slug === "easycruit") return null
    return `https://${host}`
  } catch {
    return null
  }
}

/**
 * Normalise registry rows into EasyCruit employers. Disabled and non-EasyCruit
 * rows are ignored. An EasyCruit row with a missing or invalid ats_ref is
 * skipped and reported, never guessed or silently corrected: the merged
 * registry is the single source of truth for employer base URLs.
 */
export function normalizeRegistry(text: string, source = "registry"): Registry {
  const rows = parseCsv(text)
  if (rows.length === 0) return { employers: [], errors: [], source }
  const header = rows[0].map((h) => h.trim().toLowerCase())
  const employers: Employer[] = []
  const errors: RegistryError[] = []
  const seen = new Set<string>()

  for (const row of rows.slice(1)) {
    const name = cell(row, header, "name") || cell(row, header, "orgnr") || "Unknown employer"
    const ats = cell(row, header, "ats").toLowerCase()
    const enabled = isEnabled(cell(row, header, "enabled") || "true")
    if (!enabled) continue
    if (ats !== "easycruit") continue

    const ref = cell(row, header, "ats_ref")
    const baseUrl = normalizeBaseUrl(ref)
    if (!baseUrl) {
      errors.push({ employer: name, error: "missing or invalid ats_ref; employer skipped" })
      continue
    }
    const slug = slugFromHost(new URL(baseUrl).hostname)
    if (seen.has(slug)) continue
    seen.add(slug)
    employers.push({
      name,
      orgnr: cell(row, header, "orgnr") || null,
      ats: "easycruit",
      atsRef: baseUrl,
      baseUrl,
      slug,
    })
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
// Location and query matching

/** Lowercase, remove diacritics and punctuation, collapse whitespace. */
export function normalizeText(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/ø/g, "o")
    .replace(/æ/g, "ae")
    .replace(/å/g, "a")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

/**
 * Whole-token phrase match. The location audit in trondheim-patches/plan.md
 * found substring matching produced Vennesla -> Skaun's Venn and Helle ->
 * Stjørdal's Hell; a phrase must be bounded by spaces/string edges.
 */
export function phraseMatches(haystack: string, needle: string): boolean {
  const h = normalizeText(haystack)
  const n = normalizeText(needle)
  if (!n) return false
  const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(?:^| )${escaped}(?: |$)`).test(h)
}

function municipalityIdentities(municipality: AreaMunicipality): string[] {
  return [municipality.name, ...(municipality.aliases ?? [])]
}

function municipalityNames(municipality: AreaMunicipality): string[] {
  return [...municipalityIdentities(municipality), ...(municipality.places ?? [])]
}

/**
 * Match a posting's location text against `-l`. `area` matches any municipality
 * or place in job_scraper/area.json. A named municipality matches itself and
 * every place inside it (Stjørdal -> Skatval, Hell, Hegra). A named place
 * matches only that place, never its parent municipality: `-l Skatval` must not
 * return every Stjørdal job.
 */
export function locationMatches(
  locationText: string | null | undefined,
  want: string | undefined,
  area: AreaFile | null,
): boolean {
  if (!want) return true
  const wantNorm = normalizeText(want)
  if (!wantNorm) return true
  if (!locationText) return false

  const isArea = wantNorm === "area" || wantNorm === "omradet" || wantNorm === "trondheimsomradet"
  if (isArea) {
    if (!area) return false
    return area.municipalities.some((m) => municipalityNames(m).some((name) => phraseMatches(locationText, name)))
  }

  if (phraseMatches(locationText, want)) return true

  if (area) {
    for (const municipality of area.municipalities) {
      // Only a municipality's own names/aliases can expand to its places. If
      // the wanted text is a place, `wanted` stays false and the filter does
      // not over-expand to the whole parent municipality.
      const wanted = municipalityIdentities(municipality).some((name) => normalizeText(name) === wantNorm)
      if (wanted && municipalityNames(municipality).some((name) => phraseMatches(locationText, name))) return true
    }
  }
  return false
}

/**
 * Derive a municipality hint from a registry name, for municipal employers
 * whose XML workplace is only a department name ("Ved våre barnehager").
 * Returns the canonical municipality name, or null.
 */
export function employerLocationHint(employerName: string, area: AreaFile | null): string | null {
  if (!area) return null
  for (const municipality of area.municipalities) {
    // Municipality names/aliases only: sub-places such as "Lund" or "Rye" are
    // common in employer names and would produce false municipality hints.
    const names = [municipality.name, ...(municipality.aliases ?? [])]
    if (names.some((name) => phraseMatches(employerName, name))) {
      return municipality.name
    }
  }
  return null
}

// Major Norwegian cities outside the Trondheim commute area. A workplace that
// names one of these is already an explicit place, even when it is a multi-word
// phrase such as "Bergen sentrum" or "Voss sjukehus"; appending a municipality
// hint would wrongly pull the posting into the area filter. Trondheim and the
// area's other municipalities deliberately do not appear here.
const OUT_OF_AREA_CITIES = [
  "Oslo",
  "Bergen",
  "Stavanger",
  "Sandnes",
  "Tromsø",
  "Bodø",
  "Ålesund",
  "Molde",
  "Kristiansund",
  "Kristiansand",
  "Drammen",
  "Fredrikstad",
  "Sarpsborg",
  "Skien",
  "Porsgrunn",
  "Tønsberg",
  "Moss",
  "Hamar",
  "Gjøvik",
  "Lillehammer",
  "Voss",
  "Haugesund",
  "Førde",
  "Levanger",
]

/**
 * Join a specific workplace with its municipality only when the employer is
 * named after that municipality and the workplace is a departmental string
 * rather than an explicit place of its own. Without these guards a workplace
 * like "Oslo" at Stjørdal kommune became "Oslo, Stjørdal" and wrongly matched
 * the commute area.
 */
export function combineLocation(
  primary: string | null | undefined,
  hint: string | null | undefined,
  employerName?: string | null,
): string | null {
  const p = primary?.trim() || null
  const h = hint?.trim() || null
  if (!p && !h) return null
  if (!p) return h
  if (!h || phraseMatches(p, h)) return p
  if (!employerName || !phraseMatches(employerName, h)) return p
  // Whole-token matching keeps "Voss sjukehus" and "Bergen sentrum" from being
  // rewritten, without treating a substring such as "Mosse" as Moss.
  if (OUT_OF_AREA_CITIES.some((city) => phraseMatches(p, city))) return p
  // A single-token workplace is already an explicit place name (Oslo, Bergen);
  // do not rewrite it. Departmental workplaces are multi-word and still get
  // the municipality appended for the area filter.
  if (normalizeText(p).split(" ").filter(Boolean).length <= 1) return p
  return `${p}, ${h}`
}

/**
 * Query match against title + description. Norwegian compounds mean whole-word
 * matching is wrong here: `lærer` must match `Lærervikar`. Short terms keep a
 * token boundary to avoid `it` matching `with`.
 */
export function textMatchesQuery(text: string, query: string): boolean {
  const hay = normalizeText(text)
  const terms = normalizeText(query).split(" ").filter(Boolean)
  if (terms.length === 0) return true
  return terms.every((term) => (term.length <= 3 ? phraseMatches(hay, term) : hay.includes(term)))
}

// ---------------------------------------------------------------------------
// Dates and paging

/** `YYYY-MM-DD`, `DD.MM.YYYY`, `DD/MM/YYYY` or an ISO timestamp → YYYY-MM-DD. */
export function normalizeDate(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()
  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const dmy = trimmed.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/)
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`
  const parsed = new Date(trimmed)
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
// EasyCruit URLs

export function listXmlUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/export/xml/vacancy/list.xml`
}

export function rssUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/rss`
}

export function detailHtmlUrl(baseUrl: string, id: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/vacancy/${encodeURIComponent(id)}/rss`
}

export function detailXmlUrl(baseUrl: string, id: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/export/xml/vacancy/${encodeURIComponent(id)}.xml`
}

export function canonicalVacancyUrl(slug: string, id: string): string {
  return `https://${slug}.easycruit.com/vacancy/${encodeURIComponent(id)}`
}

// ---------------------------------------------------------------------------
// RSS and XML parsing

/**
 * Inner text of a tag, with CDATA unwrapped. Entities stay encoded so each
 * caller decodes exactly once: `cleanInline` decodes inline fields, while
 * description HTML is decoded before `htmlToTextDecoded`. Decoding here as well
 * would turn `<Title>&amp;lt;script&amp;gt;</Title>` into a literal tag.
 */
function xmlText(chunk: string, tag: string): string | null {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = chunk.match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}\\s*>`, "i"))
  if (!match) return null
  let value = match[1].trim()
  const cdata = value.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/)
  if (cdata) value = cdata[1]
  value = value.trim()
  return value || null
}

function decodeXmlText(value: string | null): string | null {
  return value ? decodeHtmlEntities(value) : null
}

export interface RssItem {
  title: string | null
  link: string | null
  description: string | null
}

/**
 * Parse an EasyCruit RSS 2.0 feed. NOTE: on the sites checked every item's
 * <link> is the same first vacancy, so callers must not use it as a unique ID.
 */
export function parseRss(xml: string): RssItem[] {
  const items: RssItem[] = []
  for (const match of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const chunk = match[1]
    items.push({
      title: decodeXmlText(xmlText(chunk, "title")),
      link: decodeXmlText(xmlText(chunk, "link")),
      description: decodeXmlText(xmlText(chunk, "description")),
    })
  }
  return items
}

/** Index RSS descriptions by normalised title (the only reliable join key). */
export function rssDescriptionsByTitle(items: RssItem[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const item of items) {
    if (!item.title) continue
    const key = normalizeText(item.title)
    if (!key) continue
    const description = htmlToTextDecoded(item.description)
    if (!map.has(key) && description) map.set(key, description)
  }
  return map
}

export interface ListVacancy {
  id: string
  title: string | null
  titleHeading: string | null
  alternativeCompanyName: string | null
  location: string | null
  deadline: string | null
  engagement: string | null
  dateStart: string | null
  dateEnd: string | null
  referenceNumber: string | null
  vacancyUrl: string | null
  applicationUrl: string | null
  region: string | null
  categories: string[]
}

function attr(attrs: string, name: string): string | null {
  const match = attrs.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"))
  return match ? match[1].trim() || null : null
}

function firstVersion(inner: string): string {
  const versions = [...inner.matchAll(/<Version\b[^>]*>([\s\S]*?)<\/Version>/gi)].map((m) => m[1])
  if (versions.length === 0) return inner
  const preferred = versions.find((version) => {
    const lang = version.match(/<Version\b[^>]*\blanguage\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase()
    return lang === "nb" || lang === "no" || lang === "nn"
  })
  return preferred ?? versions[0]
}

function parseRegion(version: string): string | null {
  const region = xmlText(version, "Region")
  // Region contains nested XML (<Country><County>...), so it is not plain text.
  const county = version.match(/<County\b[^>]*>([\s\S]*?)<\/County>/i)?.[1]
  const country = version.match(/<Country\b[^>]*name\s*=\s*["']([^"']+)["']/i)?.[1]
  const parts = [county ? decodeHtmlEntities(county).trim() : null, country ? decodeHtmlEntities(country).trim() : null]
    .filter((part): part is string => Boolean(part && part.trim()))
  if (parts.length > 0) return parts.join(", ")
  return region ? cleanInline(region) : null
}

function parseCategories(version: string): string[] {
  const values: string[] = []
  for (const match of version.matchAll(/<Item\b[^>]*>([\s\S]*?)<\/Item>/gi)) {
    const value = cleanInline(match[1])
    if (value && !values.includes(value)) values.push(value)
  }
  return values
}

/** Parse `/export/xml/vacancy/list.xml`. Chunks are parsed independently. */
export function parseVacancyList(xml: string): ListVacancy[] {
  const vacancies: ListVacancy[] = []
  for (const match of xml.matchAll(/<Vacancy\b([^>]*)>([\s\S]*?)<\/Vacancy>/gi)) {
    const attrs = match[1]
    const inner = match[2]
    const version = firstVersion(inner)
    const id = attr(attrs, "id") ?? decodeXmlText(xmlText(inner, "id"))
    if (!id) continue
    vacancies.push({
      id,
      title: cleanInline(xmlText(version, "Title")),
      titleHeading: cleanInline(xmlText(version, "TitleHeading")),
      alternativeCompanyName: cleanInline(xmlText(version, "AlternativeCompanyName")),
      location: cleanInline(xmlText(version, "Location")),
      deadline: cleanInline(xmlText(version, "ApplicationDeadline")),
      engagement: cleanInline(xmlText(version, "Engagement")),
      dateStart: attr(attrs, "date_start"),
      dateEnd: attr(attrs, "date_end"),
      referenceNumber: attr(attrs, "reference_number"),
      vacancyUrl: cleanInline(xmlText(inner, "VacancyURL")),
      applicationUrl: cleanInline(xmlText(inner, "ApplicationURL")),
      region: parseRegion(version),
      categories: parseCategories(version),
    })
  }
  return vacancies
}

export interface XmlVacancyDetail {
  id: string
  title: string | null
  titleHeading: string | null
  alternativeCompanyName: string | null
  location: string | null
  deadline: string | null
  engagement: string | null
  dateStart: string | null
  dateEnd: string | null
  referenceNumber: string | null
  vacancyUrl: string | null
  applicationUrl: string | null
  region: string | null
  categories: string[]
  descriptionHtml: string | null
}

/** Parse `/export/xml/vacancy/<id>.xml`. */
export function parseVacancyXml(xml: string): XmlVacancyDetail | null {
  const root = xml.match(/<Vacancy\b([^>]*)>/i)
  if (!root) return null
  const attrs = root[1]
  const inner = xml.slice(root.index! + root[0].length)
  const version = firstVersion(inner)
  const id = attr(attrs, "id")
  if (!id) return null
  return {
    id,
    title: cleanInline(xmlText(version, "Title")),
    titleHeading: cleanInline(xmlText(version, "TitleHeading")),
    alternativeCompanyName: cleanInline(xmlText(version, "AlternativeCompanyName")),
    location: cleanInline(xmlText(version, "Location")),
    deadline: cleanInline(xmlText(version, "ApplicationDeadline")),
    engagement: cleanInline(xmlText(version, "Engagement")),
    dateStart: attr(attrs, "date_start"),
    dateEnd: attr(attrs, "date_end"),
    referenceNumber: attr(attrs, "reference_number"),
    vacancyUrl: cleanInline(xmlText(inner, "VacancyURL")),
    applicationUrl: cleanInline(xmlText(inner, "ApplicationURL")),
    region: parseRegion(version),
    categories: parseCategories(version),
    descriptionHtml: decodeXmlText(xmlText(version, "Description")),
  }
}

export interface HtmlDetail {
  title: string | null
  location: string | null
  deadline: string | null
  engagement: string | null
  worktime: string | null
  region: string | null
  description: string | null
  url: string | null
  descriptionHtml: string | null
}

/** Parse the public HTML detail at `/vacancy/<id>/rss`. */
export function parseDetailHtml(html: string, fallbackUrl: string): HtmlDetail {
  // Drop comments, script/style/template blocks and hidden elements before
  // selecting anchors, so a hidden wrapper cannot leak text into the output.
  const clean = visibleHtml(html)
  const h1 = clean.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? null
  const title =
    cleanInline(h1) ??
    cleanInline(metaContent(clean, "og:title")) ??
    cleanInline(clean.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.split(/\s+[-|–]\s+/)[0] ?? null)
  const descriptionHtml = extractDivContent(clean, "jd-description")
  return {
    title,
    location: labeledDiv(clean, "jd-location"),
    deadline: labeledDiv(clean, "jd-deadline"),
    engagement: labeledDiv(clean, "jd-engagement"),
    worktime: labeledDiv(clean, "jd-worktime"),
    region: labeledDiv(clean, "jd-region"),
    description: htmlToText(descriptionHtml),
    url: metaContent(clean, "og:url") ?? fallbackUrl,
    descriptionHtml,
  }
}

export interface PublicDetailOutcome {
  detail: HtmlDetail | null
  /** Set for challenges/403/429 and other failures; null for a genuine 404. */
  error: string | null
}

/**
 * Best-effort HTML detail for search enrichment. A genuine 404 is non-fatal
 * (no detail, no error). A WAF challenge, 403 or 429 is reported to the caller
 * so it can be surfaced in `meta.errors` while the run continues.
 */
export async function fetchPublicDetail(
  baseUrl: string,
  id: string,
  fetchImpl: FetchLike = fetch,
): Promise<PublicDetailOutcome> {
  try {
    const html = await fetchHtml(detailHtmlUrl(baseUrl, id), fetchImpl)
    if (!html) return { detail: null, error: null }
    const fallback = `${baseUrl.replace(/\/+$/, "")}/vacancy/${encodeURIComponent(id)}`
    return { detail: parseDetailHtml(html, fallback), error: null }
  } catch (error) {
    return {
      detail: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

// ---------------------------------------------------------------------------
// Detail input

export interface DetailInput {
  slug: string | null
  id: string
}

export interface DetailInputError {
  code: "BAD_ID" | "BARE_ID"
  message: string
}

/** Accept `<slug>/<id>`, `<slug>:<id>`, or a full EasyCruit vacancy URL. */
export function normalizeDetailInput(input: string): DetailInput | DetailInputError | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  if (/^\d+$/.test(trimmed)) {
    return {
      code: "BARE_ID",
      message:
        "A bare vacancy id cannot be resolved to an employer on EasyCruit; pass <slug>/<id> (for example stjordal/3673377) or a full vacancy URL",
    }
  }

  const kv = trimmed.match(/^([a-z0-9-]+)[/:](\d+)$/i)
  if (kv) return { slug: kv[1].toLowerCase(), id: kv[2] }

  const hasScheme = /^https?:\/\//i.test(trimmed)
  if (!hasScheme && !/^[a-z0-9.-]+\.[a-z]{2,}\//i.test(trimmed) && !/^[a-z0-9.-]+\.easycruit\.com/i.test(trimmed)) {
    return null
  }
  let parsed: URL
  try {
    parsed = new URL(hasScheme ? trimmed : `https://${trimmed}`)
  } catch {
    return null
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "")
  if (host !== "easycruit.com" && !host.endsWith(".easycruit.com")) return null
  const slug = slugFromHost(host)
  if (!slug || slug === "www" || slug === "easycruit") return null

  const html = parsed.pathname.match(/^\/vacancy\/(?:application\/)?(\d+)(?:\/.*)?$/i)
  if (html) return { slug, id: html[1] }
  const xml = parsed.pathname.match(/^\/export\/xml\/vacancy\/(\d+)\.xml$/i)
  if (xml) return { slug, id: xml[1] }
  return null
}

// ---------------------------------------------------------------------------
// Result shapes

export interface JobResult {
  id: string
  title: string | null
  company: string | null
  location: string | null
  date: string | null
  url: string | null
}

export interface JobDetail extends JobResult {
  description: string | null
  deadline: string | null
  employmentType: string | null
  worktime: string | null
  region: string | null
  referenceNumber: string | null
}
