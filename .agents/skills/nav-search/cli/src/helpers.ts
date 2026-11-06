// Shared helpers for nav-search-cli.
//
// Data source: NAV Arbeidsplassen's job-vacancy feed. Unlike the HTML portals,
// the feed is JSON, so the only "parsing" here is JSON shape validation plus the
// same output-hygiene rules every portal CLI follows: visibleHtml() before any
// HTML is read, stripInvisible() on everything before output, and no runtime
// dependencies.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, join, resolve } from "node:path"

export const DEFAULT_FEED_BASE = "https://pam-stilling-feed.nav.no"
export const USER_AGENT = "Mozilla/5.0 (compatible; nav-search-cli/1.0)"
export const STILLINGSANNONSE = "Stillingsannonse"

export function writeError(error: string, code: string): void {
  process.stderr.write(JSON.stringify({ error, code }) + "\n")
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = "HttpError"
    this.status = status
  }
}

export interface FetchJsonOptions {
  token?: string
  ifModifiedSince?: string
  timeoutMs?: number
}

/**
 * Fetch JSON with exponential backoff and jitter on 429/5xx (and transient
 * network failures). A 404 returns null so callers can treat "gone" as data,
 * not an exception, matching the portal-skill contract.
 */
export async function jsonFetch<T>(url: string, opts: FetchJsonOptions = {}): Promise<T | null> {
  const maxRetries = 6
  let delay = 500
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    }
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`
    if (opts.ifModifiedSince) headers["If-Modified-Since"] = opts.ifModifiedSince

    let response: Response
    try {
      response = await fetch(url, {
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(opts.timeoutMs ?? 20000),
      })
    } catch (error) {
      if (attempt === maxRetries) throw error
      const jitter = Math.floor(Math.random() * 500)
      await sleep(delay + jitter)
      delay = Math.min(delay * 2, 8000)
      continue
    }

    if (response.status === 429 || response.status >= 500) {
      if (attempt === maxRetries) {
        throw new HttpError(response.status, `Request failed: ${response.status} ${response.statusText}`)
      }
      const jitter = Math.floor(Math.random() * 500)
      await sleep(delay + jitter)
      delay = Math.min(delay * 2, 8000)
      continue
    }
    if (response.status === 404) return null
    if (!response.ok) {
      throw new HttpError(response.status, `Request failed: ${response.status} ${response.statusText}`)
    }
    try {
      return (await response.json()) as T
    } catch {
      throw new Error(`Response from ${url} was not valid JSON`)
    }
  }
  throw new Error("Request failed after max retries")
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function str(value: unknown): string | null {
  if (typeof value === "string") return value
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return null
}

/** First 10 characters if they spell YYYY-MM-DD, otherwise a UTC date derived from the timestamp. */
export function isoDate(value: string | null | undefined): string | null {
  if (!value) return null
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim())
  if (match) return match[1]
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : null
}

/** A valid ISO timestamp, preserving the source offset, or null. */
export function isoDateTime(value: string | null | undefined): string | null {
  if (!value) return null
  return Number.isFinite(Date.parse(value)) ? value.trim() : null
}

export function publicAdUrl(uuid: string): string {
  return `https://arbeidsplassen.nav.no/stillinger/stilling/${uuid}`
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

const INVISIBLE_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFE00-\uFE0F\uFEFF\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu

/** Strip characters a reader never sees but a model would, recursively. */
export function stripInvisible<T>(value: T): T {
  if (typeof value === "string") return value.replace(INVISIBLE_CHARS, "") as T
  if (Array.isArray(value)) return value.map(stripInvisible) as T
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stripInvisible(v)])) as T
  }
  return value
}

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "source", "track", "wbr",
])

function isHiddenTag(attrs: string): boolean {
  for (const match of attrs.matchAll(/([^\s"'=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    const name = match[1].toLowerCase()
    const value = match[2] ?? match[3] ?? match[4] ?? ""
    if (name === "hidden") return true
    if (name === "style" && /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|mso-hide\s*:\s*all)\b/i.test(value)) {
      return true
    }
  }
  return false
}

/**
 * Drop markup a browser never renders - comments (including Word's conditional
 * ones), <script>/<style>/<template> blocks, and elements marked hidden -
 * before tags are stripped. Copied from linkedin-search, where the reasoning
 * and edge cases are documented.
 */
export function visibleHtml(html: string): string {
  const src = html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, "")
  const open = /<([a-zA-Z][a-zA-Z0-9-]*)(\s[^>]*)?>/g
  const kept: string[] = []
  let from = 0
  let match: RegExpExecArray | null
  while ((match = open.exec(src)) !== null) {
    if (!match[2] || !isHiddenTag(match[2])) continue
    const tag = match[1].toLowerCase()
    let end = open.lastIndex
    if (!VOID_TAGS.has(tag) && !match[0].endsWith("/>")) {
      const same = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi")
      same.lastIndex = end
      end = src.length
      let depth = 1
      let inner: RegExpExecArray | null
      while ((inner = same.exec(src)) !== null) {
        if (inner[1]) depth--
        else if (!inner[0].endsWith("/>")) depth++
        if (depth === 0) {
          end = same.lastIndex
          break
        }
      }
    }
    kept.push(src.slice(from, match.index))
    from = end
    open.lastIndex = end
  }
  kept.push(src.slice(from))
  return kept.join("")
}

export function stripTags(html: string): string {
  return visibleHtml(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
}

/** Plain text for a title: visible HTML only, entities decoded, whitespace collapsed. */
export function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null
  const text = stripInvisible(decodeHtmlEntities(stripTags(value))).replace(/\s+/g, " ").trim()
  return text || null
}

/**
 * Convert a description's HTML to readable text with paragraph/list breaks.
 * Hidden markup is removed before line splitting, so a hidden element spanning
 * several block tags cannot leak through a per-line clean.
 */
export function htmlToText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const withBreaks = visibleHtml(String(value))
    .replace(/\r\n?/g, "\n")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(?:p|div|li|ul|ol|h[1-6]|tr|table|section|article)\s*>/gi, "\n")
  const lines = withBreaks
    .split("\n")
    .map((line) =>
      stripInvisible(decodeHtmlEntities(stripTags(line)))
        .replace(/\s+/g, " ")
        .replace(/\s+([.,;:!?])/g, "$1")
        .trim(),
    )
  const text = lines
    .filter((line, index) => !(line === "" && lines[index - 1] === ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return text || null
}

function displayMunicipal(value: string | null): string | null {
  if (!value) return null
  const text = stripInvisible(value).replace(/\s+/g, " ").trim()
  if (!text) return null
  return text
    .toLowerCase()
    .replace(/(^|[\s-])([a-zæøå])/g, (_, prefix: string, letter: string) => prefix + letter.toUpperCase())
}

export interface FeedPage {
  id: string | null
  next_url: string | null
  next_id: string | null
  items: Record<string, unknown>[]
}

export function parseFeedPage(raw: unknown): FeedPage {
  const root = asRecord(raw) ?? {}
  const items = Array.isArray(root.items)
    ? root.items.map(asRecord).filter((item): item is Record<string, unknown> => item !== null)
    : []
  return {
    id: str(root.id),
    next_url: str(root.next_url),
    next_id: str(root.next_id),
    items,
  }
}

export type JobStatus = "ACTIVE" | "INACTIVE" | string

export interface NormRecord {
  id: string
  uuid: string
  title: string | null
  company: string | null
  raw_company: string | null
  location: string | null
  municipal: string | null
  city: string | null
  postal_code: string | null
  date: string | null
  date_modified: string | null
  published: string | null
  expires: string | null
  deadline: string | null
  status: JobStatus
  description: string | null
  content_text: string | null
  url: string
  orgnr: string | null
  employment_type: string | null
  extent: string | null
}

export interface EmployerRow {
  orgnr: string | null
  name: string
  aliases: string[]
}

export interface AreaMunicipality {
  code?: string
  name: string
  aliases: string[]
  places: string[]
  postal_prefixes: string[]
}

export interface AreaConfig {
  name?: string
  default?: string
  municipalities: AreaMunicipality[]
}

export interface SyncState {
  version: number
  last_sync: string | null
  last_item_date: string | null
  newest_item_date: string | null
  last_page_id: string | null
  seen_page_ids: string[]
}

export function emptyState(): SyncState {
  return {
    version: 1,
    last_sync: null,
    last_item_date: null,
    newest_item_date: null,
    last_page_id: null,
    seen_page_ids: [],
  }
}

export interface Paths {
  root: string
  cachePath: string
  statePath: string
  areaPath: string
  employersPath: string | null
}

function findRepoRoot(start: string): string {
  let dir = start
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, ".agents")) || existsSync(join(dir, "job_scraper"))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return process.cwd()
}

export function resolvePaths(): Paths {
  const root = findRepoRoot(import.meta.dir)
  const env = process.env
  const cachePath = resolve(env.NAV_CACHE_PATH || join(root, "job_scraper", "nav_cache.jsonl"))
  const statePath = resolve(env.NAV_STATE_PATH || join(root, "job_scraper", "nav_feed_state.json"))
  const areaPath = resolve(env.NAV_AREA_PATH || join(root, "job_scraper", "area.json"))

  let employersPath: string | null = null
  if (env.NAV_EMPLOYERS_PATH) employersPath = resolve(env.NAV_EMPLOYERS_PATH)
  else if (existsSync(join(root, "job_scraper", "employers.csv"))) {
    employersPath = join(root, "job_scraper", "employers.csv")
  } else if (existsSync(join(root, "trondheim-patches", "employers.seed.csv"))) {
    employersPath = join(root, "trondheim-patches", "employers.seed.csv")
  }

  return { root, cachePath, statePath, areaPath, employersPath }
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
    } else if (char === '"') {
      inQuotes = true
    } else if (char === ",") {
      row.push(field)
      field = ""
    } else if (char === "\n") {
      row.push(field)
      rows.push(row)
      row = []
      field = ""
    } else if (char !== "\r") {
      field += char
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

export function loadEmployers(path: string | null): EmployerRow[] {
  if (!path || !existsSync(path)) return []
  let text = ""
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return []
  }
  const rows = parseCsv(text.replace(/^\uFEFF/, ""))
  if (rows.length < 2) return []
  const header = rows[0].map((name) => name.trim().toLowerCase())
  const orgnrIndex = header.indexOf("orgnr")
  const nameIndex = header.indexOf("name")
  const aliasesIndex = header.indexOf("aliases")
  if (nameIndex === -1) return []
  const employers: EmployerRow[] = []
  for (const row of rows.slice(1)) {
    const name = (row[nameIndex] ?? "").trim()
    if (!name) continue
    employers.push({
      orgnr: orgnrIndex >= 0 ? (row[orgnrIndex] ?? "").trim() || null : null,
      name,
      aliases: aliasesIndex >= 0
        ? (row[aliasesIndex] ?? "").split("|").map((alias) => alias.trim()).filter(Boolean)
        : [],
    })
  }
  return employers
}

function key(value: string): string {
  return stripInvisible(value).replace(/\s+/g, " ").trim().toLowerCase()
}

export function normalizeCompany(
  raw: string | null | undefined,
  orgnr: string | null | undefined,
  employers: EmployerRow[],
): string | null {
  const rawText = raw ? cleanText(raw) : null
  const org = orgnr ? orgnr.replace(/\D/g, "") : null
  if (org) {
    for (const employer of employers) {
      if (employer.orgnr && employer.orgnr.replace(/\D/g, "") === org) return employer.name
    }
  }
  if (!rawText) return null
  const wanted = key(rawText)
  const tokenize = (value: string): string[] =>
    key(value).split(/[^a-z0-9æøå]+/i).filter(Boolean)
  const wantedTokens = new Set(tokenize(rawText))
  const legalSuffixes = new Set(["hf", "as", "asa", "sa", "sf", "nuf", "da", "ans"])
  let best: { name: string; score: number } | null = null

  for (const employer of employers) {
    for (const candidate of [employer.name, ...employer.aliases]) {
      const candidateKey = key(candidate)
      if (!candidateKey) continue
      let score = 0
      if (candidateKey === wanted) {
        score = 3
      } else if (candidateKey.split(" ").length >= 2 && (wanted.includes(candidateKey) || candidateKey.includes(wanted))) {
        // Multi-word containment: "Trondheim kommune" inside
        // "Trondheim kommune helse og velferd".
        score = 2
      } else {
        const distinctive = tokenize(candidate).filter((token) => !legalSuffixes.has(token))
        // All distinctive tokens present, and at least two of them. This maps
        // "Bildediagnostikk - Seksjon røntgenradiografer, St. Olavs hospital"
        // to "ST. OLAVS HOSPITAL HF" while still refusing to let the single
        // token "SINTEF" absorb "SINTEF Ocean AS".
        if (distinctive.length >= 2 && distinctive.every((token) => wantedTokens.has(token))) {
          score = 2
        } else if (candidateKey.length >= 12 && wantedTokens.has(candidateKey)) {
          // A long single-token parent name inside a unit name, e.g.
          // "Avdeling for informasjon og teknologi, Domstoladministrasjonen".
          score = 1
        }
      }
      if (score > (best?.score ?? 0)) best = { name: employer.name, score }
    }
  }

  return best ? best.name : rawText
}

const DEFAULT_AREA_NAMES = ["Trondheim", "Malvik", "Melhus", "Skaun", "Stjørdal"]

function defaultArea(): AreaConfig {
  return {
    name: "Trondheim commute area",
    municipalities: DEFAULT_AREA_NAMES.map((name) => ({
      name,
      aliases: [name.toUpperCase()],
      places: [],
      postal_prefixes: [],
    })),
  }
}

export function loadArea(path: string): AreaConfig {
  if (!existsSync(path)) return defaultArea()
  try {
    const root = asRecord(JSON.parse(readFileSync(path, "utf8")))
    const raw = root && Array.isArray(root.municipalities) ? root.municipalities : []
    const municipalities: AreaMunicipality[] = []
    for (const item of raw) {
      const entry = asRecord(item)
      const name = entry ? str(entry.name) : null
      if (!entry || !name) continue
      const stringList = (value: unknown): string[] =>
        Array.isArray(value) ? value.map(str).filter((v): v is string => v !== null) : []
      municipalities.push({
        code: str(entry.code) ?? undefined,
        name,
        aliases: stringList(entry.aliases),
        places: stringList(entry.places),
        postal_prefixes: stringList(entry.postal_prefixes),
      })
    }
    if (municipalities.length === 0) return defaultArea()
    return {
      name: root ? str(root.name) ?? undefined : undefined,
      default: root ? str(root.default) ?? undefined : undefined,
      municipalities,
    }
  } catch {
    return defaultArea()
  }
}

function areaNames(municipality: AreaMunicipality): string[] {
  return [municipality.name, ...municipality.aliases]
    .map((name) => key(name))
    .filter(Boolean)
}

export function isInArea(record: NormRecord, area: AreaConfig): boolean {
  const municipal = key(record.municipal ?? record.location ?? "")
  const postal = (record.postal_code ?? "").replace(/\s+/g, "")
  for (const municipality of area.municipalities) {
    const names = areaNames(municipality)
    if (municipal && names.some((name) => name === municipal || municipal.includes(name) || name.includes(municipal))) {
      return true
    }
    if (postal && municipality.postal_prefixes.some((prefix) => postal.startsWith(prefix))) {
      return true
    }
  }
  return false
}

export function matchesLocation(record: NormRecord, location: string | undefined, area: AreaConfig): boolean {
  if (!location || !location.trim()) return true
  if (location.trim().toLowerCase() === "area") return isInArea(record, area)

  const wanted = key(location)
  if (!wanted) return true
  const values = [record.location, record.municipal, record.city]
    .filter((value): value is string => Boolean(value))
    .map(key)
  if (values.some((value) => value === wanted || value.includes(wanted) || wanted.includes(value))) {
    return true
  }

  // Resolve an area municipality name/alias (e.g. "Trondheim kommune") to its
  // canonical names, then match the ad against those.
  for (const municipality of area.municipalities) {
    const names = areaNames(municipality)
    if (names.some((name) => name === wanted || name.includes(wanted) || wanted.includes(name))) {
      if (values.some((value) => names.some((name) => value === name || value.includes(name) || name.includes(value)))) {
        return true
      }
    }
  }
  return false
}

export function withinJobage(record: NormRecord, days: number, now = Date.now()): boolean {
  const raw = record.date ?? record.date_modified
  if (!raw) return false
  const time = Date.parse(raw.length === 10 ? `${raw}T00:00:00Z` : raw)
  if (!Number.isFinite(time)) return false
  return time >= now - days * 86400000
}

export function parseUuid(input: string): string | null {
  const text = input.trim()
  const bare = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(text)
  if (bare) return bare[1]
  const path = /\/(?:api\/v1\/feedentry|stillinger\/stilling)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(text)
  if (path) return path[1]
  const anywhere = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(text)
  return anywhere ? anywhere[1] : null
}

/**
 * Turn one feed item into the normalized cache record. The feed carries only
 * summary fields, so description is the feed's content_text when it is more
 * than the "Stillingsannonse" placeholder; detail's full description is
 * fetched by the `detail` command.
 */
export function recordFromFeedItem(
  item: Record<string, unknown>,
  employers: EmployerRow[],
  existing?: NormRecord,
): NormRecord | null {
  const entry = asRecord(item._feed_entry) ?? {}
  const uuid = str(entry.uuid) ?? str(item.id)
  if (!uuid) return null

  const rawCompany = str(entry.businessName) ?? existing?.raw_company ?? null
  const orgnr = str(entry.orgnr) ?? existing?.orgnr ?? null
  const municipal = str(entry.municipal) ?? existing?.municipal ?? null
  const dateModified = isoDateTime(str(item.date_modified) ?? str(entry.sistEndret)) ?? existing?.date_modified ?? null
  const contentText = str(item.content_text) ?? existing?.content_text ?? null
  const description =
    contentText && contentText.trim().toLowerCase() !== STILLINGSANNONSE.toLowerCase()
      ? cleanText(contentText)
      : existing?.description ?? null

  return {
    id: uuid,
    uuid,
    title: cleanText(str(entry.title) ?? str(item.title)) ?? existing?.title ?? null,
    company: normalizeCompany(rawCompany, orgnr, employers) ?? existing?.company ?? null,
    raw_company: rawCompany,
    location: displayMunicipal(municipal) ?? existing?.location ?? null,
    municipal,
    city: existing?.city ?? null,
    postal_code: existing?.postal_code ?? null,
    date: isoDate(existing?.published) ?? isoDate(dateModified),
    date_modified: dateModified,
    published: existing?.published ?? null,
    expires: existing?.expires ?? null,
    deadline: existing?.deadline ?? null,
    status: (str(entry.status) ?? "INACTIVE").toUpperCase(),
    description,
    content_text: contentText,
    url: existing?.url ?? publicAdUrl(uuid),
    orgnr,
    employment_type: existing?.employment_type ?? null,
    extent: existing?.extent ?? null,
  }
}

function preserveDetail(existing: NormRecord, incoming: NormRecord): NormRecord {
  return {
    ...existing,
    ...incoming,
    description: incoming.description ?? existing.description,
    published: incoming.published ?? existing.published,
    expires: incoming.expires ?? existing.expires,
    deadline: incoming.deadline ?? existing.deadline,
    employment_type: incoming.employment_type ?? existing.employment_type,
    extent: incoming.extent ?? existing.extent,
    orgnr: incoming.orgnr ?? existing.orgnr,
    city: incoming.city ?? existing.city,
    postal_code: incoming.postal_code ?? existing.postal_code,
    raw_company: incoming.raw_company ?? existing.raw_company,
    company: incoming.company ?? existing.company,
    location: incoming.location ?? existing.location,
    date: incoming.date ?? existing.date,
    date_modified: incoming.date_modified ?? existing.date_modified,
    url: incoming.url || existing.url,
  }
}

/**
 * Merge an incoming feed state over the cached one. An ACTIVE item is never
 * allowed to resurrect an INACTIVE state that is newer (or equally new): the
 * feed is a change log, so the last word on a uuid wins.
 */
export function mergeRecord(existing: NormRecord | undefined, incoming: NormRecord): NormRecord {
  if (!existing) return incoming
  const incomingTime = Date.parse(incoming.date_modified ?? "")
  const existingTime = Date.parse(existing.date_modified ?? "")

  if (Number.isFinite(incomingTime) && Number.isFinite(existingTime)) {
    if (incomingTime < existingTime) return existing
    if (incomingTime === existingTime) {
      if (existing.status === "INACTIVE") return existing
      if (incoming.status === "INACTIVE") return preserveDetail(existing, incoming)
      return existing
    }
  } else if (existing.status === "INACTIVE" && incoming.status === "ACTIVE") {
    // Without comparable timestamps, fail closed rather than resurrect.
    return existing
  }

  return preserveDetail(existing, incoming)
}

export function readCacheFile(path: string): Map<string, NormRecord> {
  const records = new Map<string, NormRecord>()
  if (!existsSync(path)) return records
  let text = ""
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return records
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const parsed = asRecord(JSON.parse(line))
      if (!parsed) continue
      const record = parsed as unknown as NormRecord
      const id = record.uuid || record.id
      if (id) records.set(id, record)
    } catch {
      // A single corrupt line must not discard the rest of a user's cache.
    }
  }
  return records
}

function atomicWrite(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${Date.now()}`)
  try {
    writeFileSync(temp, data, "utf8")
    renameSync(temp, path)
  } catch (error) {
    try {
      rmSync(temp, { force: true })
    } catch {
      // Best effort cleanup.
    }
    throw error
  }
}

export function writeCacheFile(path: string, records: Map<string, NormRecord>): void {
  const sorted = [...records.values()].sort((a, b) => {
    const at = a.date_modified ? Date.parse(a.date_modified) : 0
    const bt = b.date_modified ? Date.parse(b.date_modified) : 0
    if (at !== bt) return at - bt
    return a.uuid.localeCompare(b.uuid)
  })
  const data = sorted.map((record) => JSON.stringify(record)).join("\n") + (sorted.length ? "\n" : "")
  atomicWrite(path, data)
}

export function readStateFile(path: string): SyncState {
  if (!existsSync(path)) return emptyState()
  try {
    const root = asRecord(JSON.parse(readFileSync(path, "utf8")))
    if (!root) return emptyState()
    const seen = Array.isArray(root.seen_page_ids)
      ? root.seen_page_ids.map(str).filter((id): id is string => Boolean(id))
      : []
    return {
      version: typeof root.version === "number" ? root.version : 1,
      last_sync: str(root.last_sync),
      last_item_date: str(root.last_item_date),
      newest_item_date: str(root.newest_item_date),
      last_page_id: str(root.last_page_id),
      seen_page_ids: seen.slice(-100),
    }
  } catch {
    return emptyState()
  }
}

export function writeStateFile(path: string, state: SyncState): void {
  atomicWrite(path, JSON.stringify(state, null, 2) + "\n")
}

export function sortRecords(records: NormRecord[]): NormRecord[] {
  return [...records].sort((a, b) => {
    const at = a.date_modified ? Date.parse(a.date_modified) : 0
    const bt = b.date_modified ? Date.parse(b.date_modified) : 0
    if (at !== bt) return bt - at
    return (a.title ?? "").localeCompare(b.title ?? "")
  })
}
