// Shared helpers for the Webcruiter portal skill.
//
// Data source: the public JSON endpoint behind Webcruiter's company advert
// pages. No authentication. Keep request volume low: the endpoint is public,
// but both candidate.webcruiter.com and the tenant hosts disallow generic
// crawlers in robots.txt (see ../url-reference.md).

import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

export const SEARCH_API = "https://candidate.webcruiter.com/api/odvert/companysearch"
export const UA = "Mozilla/5.0 (compatible; webcruiter-search-cli/1.0)"
export const MAX_CONCURRENCY = 4
export const PAGE_SIZE = 100
export const MAX_PER_EMPLOYER = 200

export function writeError(error: string, code: string): void {
  process.stderr.write(JSON.stringify({ error, code }) + "\n")
}

export interface FetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Fetch text with exponential backoff and jitter on 429/5xx and network
 * errors. Returns null on 404. Every other non-2xx ends the retry loop with an
 * error so a caller can record it per employer.
 */
export async function fetchText(url: string, init: FetchInit = {}): Promise<string | null> {
  const maxRetries = 6
  let delay = 500
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response: Response
    try {
      response = await fetch(url, {
        method: init.method ?? "GET",
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/json,application/xhtml+xml,*/*;q=0.8",
          "Accept-Language": "nb-NO,nb;q=0.9,en;q=0.7",
          ...(init.headers ?? {}),
        },
        body: init.body,
        redirect: "follow",
        signal: AbortSignal.timeout(init.timeoutMs ?? 20000),
      })
    } catch (e) {
      if (attempt === maxRetries) throw e
      await sleep(delay + Math.floor(Math.random() * 500))
      delay = Math.min(delay * 2, 8000)
      continue
    }

    if (response.status === 404) return null
    if (response.status === 429 || response.status >= 500) {
      if (attempt === maxRetries) {
        throw new Error(`Request failed: ${response.status} ${response.statusText}`)
      }
      await sleep(delay + Math.floor(Math.random() * 500))
      delay = Math.min(delay * 2, 8000)
      continue
    }
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status} ${response.statusText}`)
    }
    return response.text()
  }
  throw new Error("Request failed after max retries")
}

/* ------------------------------------------------------------------ */
/* HTML cleaning (copied from linkedin-search, per add-portal.md)       */
/* ------------------------------------------------------------------ */

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
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F­؜᠎​-‏‪-‮⁠-⁯︀-️﻿\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu

/** Strip characters a reader never sees from every string in an output value. */
export function stripInvisible<T>(value: T): T {
  if (typeof value === "string") return value.replace(INVISIBLE_CHARS, "") as T
  if (Array.isArray(value)) return value.map(stripInvisible) as T
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stripInvisible(v)])) as T
  }
  return value
}

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"])

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

/** Drop comments, script/style/template blocks and hidden elements before tags are stripped. */
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

/** Convert an HTML fragment to readable text, keeping paragraph/line boundaries. */
export function htmlToText(html: string): string {
  const withBreaks = visibleHtml(html)
    .replace(/\s+/g, " ")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|ul|ol|div|h\d|tr|section|article)>/gi, "\n")
  const lines = withBreaks
    .split("\n")
    .map((line) => decodeHtmlEntities(line.replace(/<[^>]+>/g, " ").replace(/[ \t]+/g, " ").trim()))
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()
}

/** Extract the inner HTML of a div identified by a class name, tracking nesting. */
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

/* ------------------------------------------------------------------ */
/* Registry and area files                                             */
/* ------------------------------------------------------------------ */

export interface Employer {
  orgnr: string
  name: string
  aliases: string
  website: string
  careerUrl: string
  ats: string
  atsRef: string
  confidence: string
  enabled: boolean
}

export interface AreaMunicipality {
  code: string
  name: string
  aliases: string[]
  places: string[]
  postal_prefixes: string[]
}

export interface Area {
  name?: string
  default?: string
  municipalities: AreaMunicipality[]
}

/** Parse CSV including quoted fields, escaped quotes and CRLF. */
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
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++
      row.push(field)
      field = ""
      if (row.some((v) => v.trim() !== "")) rows.push(row)
      row = []
    } else {
      field += ch
    }
  }
  row.push(field)
  if (row.some((v) => v.trim() !== "")) rows.push(row)
  return rows
}

/** Walk up from this module until the repo root (the directory holding .agents/ or job_scraper/). */
export function repoRoot(): string {
  let dir = import.meta.dir
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, ".agents")) || existsSync(join(dir, "job_scraper"))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return process.cwd()
}

export function loadRegistry(root = repoRoot()): Employer[] {
  const primary = join(root, "job_scraper", "employers.csv")
  const fallback = join(root, "trondheim-patches", "employers.seed.csv")
  const path = existsSync(primary) ? primary : fallback
  if (!existsSync(path)) return []

  const rows = parseCsv(readFileSync(path, "utf8"))
  if (rows.length === 0) return []
  const header = rows[0].map((h) => h.trim())
  const col = (name: string) => header.indexOf(name)
  const idx = {
    orgnr: col("orgnr"),
    name: col("name"),
    aliases: col("aliases"),
    website: col("website"),
    careerUrl: col("career_url"),
    ats: col("ats"),
    atsRef: col("ats_ref"),
    confidence: col("confidence"),
    enabled: col("enabled"),
  }

  const employers: Employer[] = []
  for (const cells of rows.slice(1)) {
    const get = (i: number) => (i >= 0 && i < cells.length ? cells[i].trim() : "")
    const enabledRaw = get(idx.enabled).toLowerCase()
    employers.push({
      orgnr: get(idx.orgnr),
      name: get(idx.name),
      aliases: get(idx.aliases),
      website: get(idx.website),
      careerUrl: get(idx.careerUrl),
      ats: get(idx.ats).toLowerCase(),
      atsRef: get(idx.atsRef),
      confidence: get(idx.confidence),
      enabled: ["true", "1", "yes", "y"].includes(enabledRaw),
    })
  }
  return employers
}

export function filterEmployers(rows: Employer[], ats: string): Employer[] {
  return rows.filter((row) => row.enabled && row.ats === ats)
}

export function loadArea(root = repoRoot()): Area | null {
  const path = join(root, "job_scraper", "area.json")
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Area
    if (!Array.isArray(parsed.municipalities)) return null
    return parsed
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* Text, location and date helpers                                     */
/* ------------------------------------------------------------------ */

export function fold(value: string): string {
  return value
    .toLowerCase()
    .replace(/æ/g, "ae")
    .replace(/ø/g, "o")
    .replace(/å/g, "a")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

export function matchesQuery(query: string, fields: string[]): boolean {
  const haystack = fold(fields.join(" "))
  return fold(query)
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term))
}

function hasPostalPrefix(haystack: string, prefixes: string[]): boolean {
  for (const match of haystack.matchAll(/\b(\d{4})\b/g)) {
    if (prefixes.some((prefix) => match[1].startsWith(prefix))) return true
  }
  return false
}

function municipalityMatches(haystack: string, m: AreaMunicipality): boolean {
  const names = [m.name, ...(m.aliases ?? []), ...(m.places ?? [])]
  if (names.some((name) => name && haystack.includes(fold(name)))) return true
  return hasPostalPrefix(haystack, m.postal_prefixes ?? [])
}

/**
 * Match a posting's location text against `--location`.
 *
 * `area` checks every municipality's name, aliases, places and postal
 * prefixes from job_scraper/area.json. Any other value matches the text
 * directly, or - when the value names a municipality - any place inside it
 * (e.g. "-l Trondheim" also matches "Ranheim"). Omit the flag for no filter.
 */
export function locationMatches(locationText: string, filter: string | undefined, area: Area | null): boolean {
  if (!filter) return true
  const haystack = fold(locationText)
  if (!haystack) return false
  const wanted = fold(filter)

  if (wanted === "area") {
    if (!area) throw new Error("job_scraper/area.json is missing, so --location area cannot be applied")
    return area.municipalities.some((m) => municipalityMatches(haystack, m))
  }

  if (haystack.includes(wanted)) return true
  if (area) {
    const municipality = area.municipalities.find(
      (m) => fold(m.name) === wanted || (m.aliases ?? []).some((a) => fold(a) === wanted),
    )
    if (municipality && municipalityMatches(haystack, municipality)) return true
  }
  return false
}

/** Parse a dd/mm/yyyy or dd.mm.yyyy or ISO date into YYYY-MM-DD. */
export function toIsoDate(value: string): string | null {
  const trimmed = value.trim()
  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const dmy = trimmed.match(/(\d{1,2})[/.](\d{1,2})[/.](\d{4})/)
  if (!dmy) return null
  const day = dmy[1].padStart(2, "0")
  const month = dmy[2].padStart(2, "0")
  return `${dmy[3]}-${month}-${day}`
}

export function isWithinDays(dateIso: string, days: number, now = new Date()): boolean {
  const date = Date.parse(`${dateIso}T00:00:00Z`)
  if (!Number.isFinite(date)) return false
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const diffDays = Math.floor((today - date) / 86400000)
  return diffDays <= days
}

/* ------------------------------------------------------------------ */
/* Result shape and concurrency                                        */
/* ------------------------------------------------------------------ */

export interface JobResult {
  id: string
  title: string
  company: string | null
  location: string | null
  date: string | null
  url: string
}

export interface MetaError {
  employer: string
  error: string
}

export interface ParsedResult {
  result: JobResult
  locationText: string
  queryText: string
}

export async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++
      if (index >= items.length) return
      await fn(items[index])
    }
  })
  await Promise.all(workers)
}

export function sortResults(results: JobResult[]): JobResult[] {
  return [...results].sort((a, b) => {
    if (a.date && b.date) return a.date < b.date ? 1 : a.date > b.date ? -1 : a.title.localeCompare(b.title)
    if (a.date) return -1
    if (b.date) return 1
    return a.title.localeCompare(b.title)
  })
}

export function paginate<T>(results: T[], page: number, limit?: number): T[] {
  const size = limit ?? 50
  const start = (page - 1) * size
  return results.slice(start, start + size)
}
