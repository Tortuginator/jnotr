// Data source: HR Manager / Talentech public job portal.
//
//   RSS:    https://api.hr-manager.net/JobPortal.svc/<customer>/PositionList/rss/
//   Detail: https://candidate.hr-manager.net/ApplicationInit.aspx?cid=…&ProjectId=…
//
// No credentials. Zero runtime dependencies: Bun + fetch + regex. Employer rows
// come from job_scraper/employers.csv (ats=hrmanager). A row may carry
// `customer=<name>` or `cid=<n>`; cids are resolved through the public RSS
// endpoint, never by guessing a customer name.

import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

export const DEFAULT_API_BASE = "https://api.hr-manager.net"
export const DEFAULT_CANDIDATE_BASE = "https://candidate.hr-manager.net"
export const DEFAULT_LIMIT = 50

const UA = "Mozilla/5.0 (compatible; hrmanager-search-cli/1.0)"

export function apiBase(): string {
  return (process.env.HRMANAGER_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, "")
}

export function candidateBase(): string {
  return (process.env.HRMANAGER_CANDIDATE_BASE || DEFAULT_CANDIDATE_BASE).replace(/\/+$/, "")
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

export async function fetchTextRaw(
  url: string,
  fetchImpl: FetchLike = fetch,
  accept = "application/xml,text/xml,application/rss+xml,*/*;q=0.8",
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

/** Fetch text. Returns null on 404; throws on any other non-2xx. */
export async function getText(url: string, fetchImpl: FetchLike = fetch): Promise<string | null> {
  const response = await fetchTextRaw(url, fetchImpl)
  if (!response || response.status === 404) return null
  if (!response.ok) throw new Error(`request failed: ${response.status} ${response.statusText}`)
  return response.text
}

// ---------------------------------------------------------------------------
// Output hygiene (copied from linkedin-search/helpers.ts)
// ---------------------------------------------------------------------------

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

/** Extract the inner HTML of a <div id="...">, counting nested divs. */
export function extractDivById(html: string, id: string): string | null {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const openRe = new RegExp(`<div[^>]*\\bid\\s*=\\s*"${escaped}"[^>]*>`, "i")
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
  const candidates = dir ? [join(dir, "employers.csv")] : []
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
      enabled: ["true", "1", "yes", "y"].includes(cell(row, idx.enabled).toLowerCase()),
    })
  }
  return employers
}

export function readRegistry(path = registryPath()): Employer[] {
  return parseRegistryCsv(readFileSync(path, "utf8"))
}

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
  if (hay.some((h) => containsTerm(h, wantNorm))) return true
  for (const m of area.municipalities) {
    const names = [m.name, ...(m.aliases ?? []), ...(m.places ?? [])].map(normalizeText)
    if (!names.includes(wantNorm)) continue
    if (hay.some((h) => names.some((n) => containsTerm(h, n)))) return true
  }
  return false
}

export function parseDate(value: string | null | undefined): string | null {
  if (!value) return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString().slice(0, 10)
}

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
// HR Manager refs, RSS and location extraction
// ---------------------------------------------------------------------------

export interface HrRef {
  kind: "customer" | "cid"
  value: string
}

export function parseHrRef(ref: string): HrRef | null {
  const trimmed = ref.trim()
  if (!trimmed) return null
  const customerKv = trimmed.match(/(?:^|[?&])customer=([^&/?#]+)/i)
  if (customerKv) return { kind: "customer", value: decodeURIComponent(customerKv[1]) }
  const cidKv = trimmed.match(/(?:^|[?&])cid=(\d+)/i)
  if (cidKv) return { kind: "cid", value: cidKv[1] }
  if (/^\d+$/.test(trimmed)) return { kind: "cid", value: trimmed }
  if (/^[A-Za-z0-9._-]+$/.test(trimmed)) return { kind: "customer", value: trimmed }
  return null
}

export function feedUrl(customer: string): string {
  return `${apiBase()}/JobPortal.svc/${encodeURIComponent(customer)}/PositionList/rss/?protype=RecruitmentProject&incads=true`
}

/**
 * Resolve a numeric cid to a customer name through the public RSS endpoint.
 * The endpoint answers 400 with a `<channel><link>…customer=<name></link>`
 * body for valid cids; that link is the resolution signal. `list.aspx` is
 * disallowed by candidate.hr-manager.net/robots.txt, so it is not used.
 */
export async function resolveCustomer(cid: string, fetchImpl: FetchLike = fetch): Promise<string> {
  const url = `${apiBase()}/JobPortal.svc/${encodeURIComponent(cid)}/PositionList/rss/?protype=RecruitmentProject&incads=true`
  const response = await fetchTextRaw(url, fetchImpl)
  if (!response) throw new Error(`could not resolve cid=${cid}: RSS endpoint returned 404`)
  const match = response.text.match(/customer=([A-Za-z0-9._-]+)/i)
  if (!match) {
    throw new Error(`could not resolve cid=${cid} to an HR Manager customer (no customer link in response)`)
  }
  return match[1]
}

export interface RssItem {
  guid: string
  link: string
  title: string
  description: string
  pubDate: string
}

function tagText(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i")
  const m = xml.match(re)
  if (!m) return null
  return m[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, "$1").trim()
}

/** Parse RSS <item> elements with regex; one malformed item cannot sink the feed. */
export function parseRss(xml: string): RssItem[] {
  const items: RssItem[] = []
  const re = /<item\b[^>]*>([\s\S]*?)<\/item>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const chunk = m[1]
    const title = tagText(chunk, "title")
    if (!title) continue
    const guidRaw = tagText(chunk, "guid") ?? ""
    const linkText = tagText(chunk, "link")
    const atomLink = chunk.match(/<(?:\w+:)?link\b[^>]*\bhref\s*=\s*"([^"]+)"/i)
    const link = decodeHtmlEntities(linkText || atomLink?.[1] || "")
    const description = tagText(chunk, "description") ?? ""
    const pubDate = tagText(chunk, "pubDate") ?? ""
    const guid = decodeHtmlEntities(guidRaw) || projectIdFromUrl(link) || link
    if (!link) continue
    items.push({ guid, link, title: decodeHtmlEntities(title), description, pubDate })
  }
  return items
}

export function projectIdFromUrl(url: string): string | null {
  const m = url.match(/[?&]ProjectId=(\d+)/i)
  return m ? m[1] : null
}

export interface PlaceEntry {
  norm: string
  display: string
}

export function placeEntries(area: Area): PlaceEntry[] {
  const seen = new Map<string, string>()
  for (const m of area.municipalities) {
    for (const name of [m.name, ...(m.aliases ?? []), ...(m.places ?? [])]) {
      const norm = normalizeText(name)
      if (norm && !seen.has(norm)) seen.set(norm, name)
    }
  }
  return [...seen.entries()]
    .map(([norm, display]) => ({ norm, display }))
    .sort((a, b) => b.norm.length - a.norm.length)
}

/**
 * Location from the trailing title segment, e.g. "Finansrådgiver - Namsos".
 * Only short, place-shaped suffixes are accepted; a department word such as
 * "Verdipapirtjenester" is treated as a location, which is harmless for area
 * filtering (it simply does not match).
 */
export function titleLocation(title: string): string | null {
  const m = title.match(/\s[-–—]\s*([^-–—|]{2,50})\s*$/)
  if (!m) return null
  const candidate = m[1].trim()
  if (!candidate || candidate.split(/\s+/).length > 6) return null
  if (/[.!?]\s*$/.test(candidate)) return null
  // Department words are not places; keep the location null instead of showing
  // "Verdipapirtjenester" as if it were a town.
  if (/(?:tjenester|forvaltning|forsikring|utvikling|finans|konsern|avdeling|seksjon|team|stab|marked|salg|okonomi)$/i.test(candidate)) {
    return null
  }
  return candidate
}

/**
 * Conservative description fallback. It only accepts a place from area.json
 * when it is directly followed by a hiring/location verb, as in
 * "På Heimdal søker vi …". This avoids matching boilerplate such as
 * "Hovedkontoret vårt ligger i Trondheim" on a Namsos posting.
 */
export function descriptionLocation(text: string, area: Area): string | null {
  const norm = normalizeText(text)
  if (!norm) return null
  for (const entry of placeEntries(area)) {
    const re = new RegExp(
      `(?:^| )(?:pa|i|ved|til) ${entry.norm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} (?=(?:soker|ligger|holder|har|kontor|avdeling|rekrutterer))`,
    )
    if (re.test(norm)) return entry.display
  }
  return null
}

export function extractLocation(title: string, descriptionHtml: string, area: Area): string | null {
  const fromTitle = titleLocation(title)
  if (fromTitle) return fromTitle
  const text = htmlToText(decodeHtmlEntities(descriptionHtml))
  return descriptionLocation(text, area)
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
  descriptionText: string
}

export function mapRssItem(item: RssItem, employerName: string, area: Area): LocationMapped {
  const descriptionText = htmlToText(decodeHtmlEntities(item.description))
  const location = extractLocation(item.title, item.description, area)
  return {
    result: {
      id: item.guid || projectIdFromUrl(item.link) || item.link,
      title: item.title,
      company: employerName || null,
      location,
      date: parseDate(item.pubDate),
      url: item.link,
    },
    loc: { text: location },
    descriptionText,
  }
}

export function matchesQuery(entry: LocationMapped, query: string | undefined): boolean {
  if (!query) return true
  const q = normalizeText(query)
  if (!q) return true
  return normalizeText(`${entry.result.title} ${entry.descriptionText}`).includes(q)
}

export interface FeedTarget {
  customer: string
  employerName: string
}

/** Resolve every enabled row to a feed target, grouping shared customers. */
export async function resolveTargets(
  employers: Employer[],
  fetchImpl: FetchLike = fetch,
): Promise<{ targets: FeedTarget[]; errors: Array<{ employer: string; error: string }> }> {
  const targets: FeedTarget[] = []
  const seen = new Set<string>()
  const errors: Array<{ employer: string; error: string }> = []
  for (const employer of employers) {
    const ref = parseHrRef(employer.atsRef)
    if (!ref) {
      errors.push({ employer: employer.name, error: `registry ats_ref ${JSON.stringify(employer.atsRef)} is not customer=<name> or cid=<n>` })
      continue
    }
    try {
      const customer = ref.kind === "customer" ? ref.value : await resolveCustomer(ref.value, fetchImpl)
      const key = customer.toLowerCase()
      if (seen.has(key)) continue // shared feed: attribute jobs to the first row only
      seen.add(key)
      targets.push({ customer, employerName: employer.name })
    } catch (e) {
      errors.push({ employer: employer.name, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return { targets, errors }
}

export async function fetchTarget(
  target: FeedTarget,
  area: Area,
  opts: { query?: string; location?: string; jobage?: number },
  fetchImpl: FetchLike = fetch,
): Promise<LocationMapped[]> {
  const xml = await getText(feedUrl(target.customer), fetchImpl)
  if (!xml) throw new Error(`position list returned 404 for customer "${target.customer}"`)
  const items = parseRss(xml)
  const out: LocationMapped[] = []
  for (const item of items) {
    const entry = mapRssItem(item, target.employerName, area)
    if (!locationMatches(entry.loc, opts.location, area)) continue
    if (!withinJobAge(entry.result.date, opts.jobage)) continue
    if (!matchesQuery(entry, opts.query)) continue
    out.push(entry)
  }
  return out
}

export interface DetailInput {
  url?: string
  customer?: string
  id: string
}

export function normalizeDetailInput(input: string): DetailInput | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  const hasScheme = /^https?:\/\//i.test(trimmed)
  if (hasScheme || /^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(trimmed)) {
    let parsed: URL
    try {
      parsed = new URL(hasScheme ? trimmed : `https://${trimmed}`)
    } catch {
      return null
    }
    let candidateHost = ""
    try {
      candidateHost = new URL(candidateBase()).hostname
    } catch {
      candidateHost = ""
    }
    if (!(/(^|\.)hr-manager\.net$/i.test(parsed.hostname) || parsed.hostname === candidateHost)) return null
    if (!/\/ApplicationInit\.aspx$/i.test(parsed.pathname)) return null
    const projectId = parsed.searchParams.get("ProjectId")
    return projectId ? { url: parsed.toString(), id: projectId } : null
  }

  const kv = trimmed.match(/^([A-Za-z0-9._-]+)[:/]([A-Za-z0-9-]+)$/)
  if (kv) return { customer: kv[1], id: kv[2] }
  if (/^[A-Za-z0-9_-]+$/.test(trimmed)) return { id: trimmed }
  return null
}

export interface JobDetail extends JobResult {
  description: string | null
}

function metaContent(html: string, key: string): string | null {
  const re = new RegExp(`<meta[^>]+(?:property|name)\\s*=\\s*"${key}"[^>]*content\\s*=\\s*"([^"]*)"`, "i")
  const match = re.exec(html)
  return match ? decodeHtmlEntities(match[1]) : null
}

export function parseDetailHtml(html: string, id: string, url: string, area?: Area): JobDetail {
  const ogTitle = metaContent(html, "og:title")
  const rawTitle = ogTitle || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "(untitled)"
  const title = rawTitle.replace(/\s*Talentech\s*-\s*/i, "").trim() || "(untitled)"

  const inner = extractDivById(html, "AdvertisementInnerContent")
  let description: string | null = null
  if (inner) description = htmlToText(inner) || null
  if (!description) {
    const meta = metaContent(html, "description")
    if (meta) description = meta.trim() || null
  }

  const location = titleLocation(title) ?? (area && inner ? descriptionLocation(htmlToText(inner), area) : null)

  return {
    id,
    title,
    company: null,
    location,
    date: null,
    url,
    description,
  }
}
