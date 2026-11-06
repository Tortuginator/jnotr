// Shared helpers for the ReachMee portal skill.
//
// ReachMee exposes two public list shapes:
//   * legacy ext pages: https://webNNN.reachmee.com/ext/<I-code>/<customer>/main
//     These require a per-customer `validator` query parameter.
//   * Attract career sites: https://<slug>.attract.reachmee.com/jobs
//     Server-rendered, no validator.
// See ../url-reference.md for the verified details.

import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

export const UA = "Mozilla/5.0 (compatible; reachmee-search-cli/1.0)"
export const MAX_CONCURRENCY = 4

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

/** Fetch text with exponential backoff and jitter on 429/5xx and network errors; null on 404. */
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

export function htmlToText(html: string): string {
  const withBreaks = visibleHtml(html)
    .replace(/\s+/g, " ")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|ul|ol|div|h\d|tr|section|article|td|th)>/gi, "\n")
  const lines = withBreaks
    .split("\n")
    .map((line) => decodeHtmlEntities(line.replace(/<[^>]+>/g, " ").replace(/[ \t]+/g, " ").trim()))
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()
}

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
    employers.push({
      orgnr: get(idx.orgnr),
      name: get(idx.name),
      aliases: get(idx.aliases),
      website: get(idx.website),
      careerUrl: get(idx.careerUrl),
      ats: get(idx.ats).toLowerCase(),
      atsRef: get(idx.atsRef),
      confidence: get(idx.confidence),
      enabled: ["true", "1", "yes", "y"].includes(get(idx.enabled).toLowerCase()),
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

function foldTokens(value: string): string[] {
  return fold(value).split(/[^a-z0-9]+/).filter(Boolean)
}

/** Whole-token phrase match, so "Venn" does not match "Vennesla" and
 * "Kvål" does not match "kvalifisering". */
function containsPlace(haystack: string, needle: string): boolean {
  const wanted = foldTokens(needle)
  if (wanted.length === 0) return false
  const tokens = foldTokens(haystack)
  for (let i = 0; i + wanted.length <= tokens.length; i++) {
    if (wanted.every((token, j) => tokens[i + j] === token)) return true
  }
  return false
}

function municipalityMatches(haystack: string, m: AreaMunicipality): boolean {
  const names = [m.name, ...(m.aliases ?? []), ...(m.places ?? [])]
  if (names.some((name) => name && containsPlace(haystack, name))) return true
  return hasPostalPrefix(haystack, m.postal_prefixes ?? [])
}

export function locationMatches(locationText: string, filter: string | undefined, area: Area | null): boolean {
  if (!filter) return true
  const haystack = fold(locationText)
  if (!haystack) return false
  const wanted = fold(filter)

  if (wanted === "area") {
    if (!area) throw new Error("job_scraper/area.json is missing, so --location area cannot be applied")
    return area.municipalities.some((m) => municipalityMatches(haystack, m))
  }

  if (containsPlace(haystack, wanted)) return true
  if (area) {
    const municipality = area.municipalities.find(
      (m) => fold(m.name) === wanted || (m.aliases ?? []).some((a) => fold(a) === wanted),
    )
    if (municipality && municipalityMatches(haystack, municipality)) return true
  }
  return false
}

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

/* ------------------------------------------------------------------ */
/* ReachMee source resolution                                         */
/* ------------------------------------------------------------------ */

export interface ReachSource {
  kind: "ext" | "attract"
  base: string
  code: string | null
  customer: string | null
  site: string
  lang: string
  validator: string | null
  listUrl: string
}

export function buildExtListUrl(
  base: string,
  code: string,
  customer: string,
  site: string,
  lang: string,
  validator: string,
): string {
  return `${base}/ext/${code}/${customer}/main?site=${encodeURIComponent(site)}&lang=${encodeURIComponent(lang)}&validator=${encodeURIComponent(validator)}`
}

/**
 * Parse a registry `ats_ref` into a ReachMee source.
 *
 * Verified forms:
 *   https://web103.reachmee.com/ext/I010/2581/main?site=6&lang=NO&validator=...
 *   https://web103.reachmee.com/ext/I010/2581              (no validator; needs discovery)
 *   https://web103.reachmee.com/ext/I003/475               (stale seed form; 404)
 *   https://nina.attract.reachmee.com                      (Attract career site)
 *   https://web103.reachmee.com                             (host only; needs discovery)
 */
export function parseSourceRef(ref: string): ReachSource | null {
  const trimmed = (ref ?? "").trim()
  if (!trimmed) return null
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }

  if (/\.attract\.reachmee\.com$/i.test(url.hostname)) {
    return {
      kind: "attract",
      base: url.origin,
      code: null,
      customer: null,
      site: "",
      lang: "NO",
      validator: null,
      listUrl: `${url.origin}/jobs`,
    }
  }

  if (!/^web\d+\.reachmee\.com$/i.test(url.hostname)) return null

  const path = url.pathname.match(/\/ext\/(I\d+)\/(\d+)/i)
  const code = path ? path[1].toUpperCase() : null
  const customer = path ? path[2] : null
  const site = url.searchParams.get("site") ?? "1"
  const lang = url.searchParams.get("lang") ?? "NO"
  const validator = url.searchParams.get("validator")
  const base = url.origin
  const listUrl =
    code && customer && validator ? buildExtListUrl(base, code, customer, site, lang, validator) : ""

  return {
    kind: "ext",
    base,
    code,
    customer,
    site,
    lang,
    validator,
    listUrl,
  }
}

export function websiteSlug(website: string): string | null {
  const trimmed = (website ?? "").trim()
  if (!trimmed) return null
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const host = new URL(withScheme).hostname.toLowerCase()
    const labels = host.split(".").filter(Boolean)
    if (labels.length < 2) return null
    return labels[0] === "www" ? labels[1] ?? null : labels[0]
  } catch {
    return null
  }
}

/** Find ReachMee list sources linked from a career page (validator discovery). */
export function findReachmeeSources(html: string): ReachSource[] {
  const text = decodeHtmlEntities(html)
  const candidates: ReachSource[] = []
  const seen = new Set<string>()

  for (const match of text.matchAll(/(?:https?:)?\/\/[^\s"'<>]+reachmee\.com[^\s"'<>]*/gi)) {
    let raw = match[0].replace(/[).,;]+$/, "")
    if (raw.startsWith("//")) raw = `https:${raw}`
    const source = parseSourceRef(raw)
    if (!source || seen.has(source.listUrl)) continue
    const usable =
      source.kind === "attract" ||
      (source.kind === "ext" && Boolean(source.code && source.customer && source.validator && source.listUrl))
    if (!usable) continue
    seen.add(source.listUrl)
    candidates.push(source)
  }

  return candidates
}

function preferSource(candidates: ReachSource[], initial: ReachSource | null): ReachSource | null {
  if (candidates.length === 0) return null
  if (initial?.code && initial.customer) {
    const same = candidates.find((source) => source.code === initial.code && source.customer === initial.customer)
    if (same) return same
  }
  return candidates[0]
}

/**
 * Resolve an employer's ReachMee source. If `ats_ref` has a validator (or is
 * an Attract site) it is used directly. Otherwise the skill tries
 * `<website-slug>.attract.reachmee.com/jobs`, then reads the registry
 * `career_url` for a ReachMee link that carries a validator.
 */
export async function resolveSource(
  employer: Employer,
  fetcher: (url: string, init?: FetchInit) => Promise<string | null> = fetchText,
): Promise<ReachSource | null> {
  const initial = parseSourceRef(employer.atsRef)
  if (initial?.kind === "attract") return initial
  if (initial?.kind === "ext" && initial.code && initial.customer && initial.validator && initial.listUrl) {
    return initial
  }

  const slug = websiteSlug(employer.website)
  if (slug) {
    const attractBase = `https://${slug}.attract.reachmee.com`
    const html = await fetcher(`${attractBase}/jobs`)
    if (html && /at-jobs-block|at-jobs-list/i.test(html)) {
      return {
        kind: "attract",
        base: attractBase,
        code: null,
        customer: null,
        site: "",
        lang: "NO",
        validator: null,
        listUrl: `${attractBase}/jobs`,
      }
    }
  }

  const career = employer.careerUrl || (employer.website ? `https://${employer.website}` : "")
  if (/^https?:\/\//i.test(career)) {
    const html = await fetcher(career)
    if (html) {
      const picked = preferSource(findReachmeeSources(html), initial)
      if (picked) return picked
    }
  }

  return null
}

/* ------------------------------------------------------------------ */
/* List parsing                                                       */
/* ------------------------------------------------------------------ */

const TITLE_HEADER = /stilling|jobb|jobbrubrik|befattning|tjanst|title|toimeksiannot|job ad/
const LOCATION_HEADERS = [
  /^(by|sted|ort|city|plats|location|place|arbeidssted|paikkakunta)$/,
  /^(region|geographical area|fylke|kommune|municipality)$/,
  /^(land|country)$/,
]
const DATE_HEADER = /^(publicerad|published$|publisert$|publiceringsdatum|julkaistu)/
const DEADLINE_HEADER =
  /soknadsfrist|sista ansokningsdag|sista ansokningsdatum|application deadline|viimeinen hakupaivamaara|publish to date|published to/

function headerLabels(html: string): string[] {
  const thead = html.match(/<thead[^>]*>([\s\S]*?)<\/thead>/i)?.[1]
  if (!thead) return []
  return [...thead.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => htmlToText(m[1]))
}

function headerIndex(labels: string[], pattern: RegExp): number {
  return labels.findIndex((label) => pattern.test(fold(label)))
}

function textOrNull(html: string): string | null {
  const text = htmlToText(html).replace(/\s+/g, " ").trim()
  return text || null
}

function isDateLike(text: string): boolean {
  return /^\s*(soknadsfrist|sista ansokningsdag|sista ansokningsdatum|publicerad|published|publisert|publiceringsdatum|application deadline|viimeinen)/i.test(
    fold(text),
  )
}

function extractDate(html: string): string | null {
  const order = html.match(/data-order=["']([^"']+)["']/i)
  if (order) {
    const parsed = toIsoDate(order[1])
    if (parsed) return parsed
  }
  const iso = html.match(/\b(\d{4}-\d{2}-\d{2})\b/)
  if (iso) return toIsoDate(iso[1])
  const dmy = html.match(/\b(\d{1,2}[./]\d{1,2}[./]\d{4})\b/)
  return dmy ? toIsoDate(dmy[1]) : null
}

function absoluteUrl(href: string, base: string): string {
  const decoded = decodeHtmlEntities(href).trim()
  if (decoded.startsWith("//")) return `https:${decoded}`
  if (decoded.startsWith("/")) {
    try {
      return new URL(decoded, base).toString()
    } catch {
      return decoded
    }
  }
  return decoded
}

/** Parse a legacy `/ext/.../main` list table. */
export function parseExtList(html: string, company: string, base: string): ParsedResult[] {
  const labels = headerLabels(html)
  const titleIdx = headerIndex(labels, TITLE_HEADER)
  const locIndices = LOCATION_HEADERS.map((pattern) => headerIndex(labels, pattern)).filter((index) => index >= 0)
  const dateIdx = headerIndex(labels, DATE_HEADER)
  const deadlineIdx = headerIndex(labels, DEADLINE_HEADER)

  const tbody = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i)?.[1] ?? html
  const rows = tbody.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) ?? []
  const results: ParsedResult[] = []

  for (const row of rows) {
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1])
    if (cells.length === 0) continue

    let href: string | null = null
    let title = ""
    let titleCell = -1
    for (let i = 0; i < cells.length; i++) {
      const anchor = cells[i].match(/<a\b[^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/i)
      if (!anchor) continue
      const rawHref = decodeHtmlEntities(anchor[1])
      if (!/\/job(?:\?|$)|job_id=/i.test(rawHref)) continue
      href = absoluteUrl(anchor[1], base)
      title = htmlToText(anchor[2])
      titleCell = i
      break
    }
    if (!href || !title) continue

    let location: string | null = null
    for (const index of locIndices) {
      if (index >= cells.length) continue
      location = textOrNull(cells[index])
      if (location) break
    }
    if (!location) {
      for (let i = 0; i < cells.length; i++) {
        if (i === titleCell) continue
        const text = textOrNull(cells[i])
        if (!text || isDateLike(text)) continue
        if (/^\d{1,2}[./]\d{1,2}[./]\d{4}$/.test(text) || /^\d+$/.test(text)) continue
        location = text
        break
      }
    }

    let date: string | null = null
    if (dateIdx >= 0 && dateIdx < cells.length) {
      date = extractDate(cells[dateIdx])
    } else if (deadlineIdx < 0) {
      const publishedCell = cells.find((cell) => isDateLike(htmlToText(cell)) && /publicerad|published|publisert/i.test(fold(htmlToText(cell))))
      if (publishedCell) date = extractDate(publishedCell)
    }

    const url = href
    const result: JobResult = {
      id: url,
      title,
      company: company.trim() || null,
      location,
      date,
      url,
    }

    results.push({
      result,
      locationText: location ?? "",
      queryText: [title, company, location ?? "", htmlToText(row)].filter(Boolean).join(" "),
    })
  }

  return results
}

/** Parse an Attract `/jobs` list. */
export function parseAttractList(html: string, company: string, base: string): ParsedResult[] {
  const headerChunk = html.match(/<li[^>]*class="[^"]*at-joblist-header[^"]*"[^>]*>([\s\S]*?)<\/li>/i)?.[1] ?? ""
  const labels = [...headerChunk.matchAll(/<h5\b[^>]*title=["']([^"']*)["'][^>]*>/gi)].map((m) => m[1])
  const locIndices = LOCATION_HEADERS.map((pattern) => headerIndex(labels, pattern)).filter((index) => index >= 0)
  const dateIdx = headerIndex(labels, DATE_HEADER)

  const items = [...html.matchAll(/<li[^>]*class="[^"]*at-jobs-list-item[^"]*"[^>]*>([\s\S]*?)<\/li>/gi)]
  const results: ParsedResult[] = []

  for (const item of items) {
    const chunk = item[1]
    if (/at-joblist-header/i.test(chunk)) continue

    const anchor = chunk.match(
      /<h6[^>]*class="[^"]*at-job-title[^"]*"[^>]*>[\s\S]*?<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i,
    )
    if (!anchor) continue
    const url = absoluteUrl(anchor[1], base)
    const title = htmlToText(anchor[2])
    if (!title || !url) continue

    const cells = [...chunk.matchAll(/<div[^>]*class="[^"]*at-jobs-list-cell-[^"]*"[^>]*>([\s\S]*?)<\/div>/gi)].map(
      (m) => m[1],
    )

    let location: string | null = null
    for (const index of locIndices) {
      if (index >= cells.length) continue
      location = textOrNull(cells[index])
      if (location) break
    }
    const date = dateIdx >= 0 && dateIdx < cells.length ? extractDate(cells[dateIdx]) : null

    const result: JobResult = {
      id: url,
      title,
      company: company.trim() || null,
      location,
      date,
      url,
    }

    results.push({
      result,
      locationText: location ?? "",
      queryText: [title, company, htmlToText(chunk)].filter(Boolean).join(" "),
    })
  }

  return results
}

/* ------------------------------------------------------------------ */
/* Detail parsing                                                     */
/* ------------------------------------------------------------------ */

export interface DetailTarget {
  url: string
  kind: "ext" | "attract"
  code: string | null
  customer: string | null
}

export function normalizeDetailTarget(input: string): DetailTarget | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }

  if (/\.attract\.reachmee\.com$/i.test(url.hostname)) {
    if (!/\/jobs\/[^/?#]+/i.test(url.pathname)) return null
    return { url: url.toString(), kind: "attract", code: null, customer: null }
  }

  if (/^web\d+\.reachmee\.com$/i.test(url.hostname)) {
    const path = url.pathname.match(/\/ext\/(I\d+)\/(\d+)/i)
    if (!path || !/\/job(?:\/|$)/i.test(url.pathname)) return null
    return { url: url.toString(), kind: "ext", code: path[1].toUpperCase(), customer: path[2] }
  }

  return null
}

export interface JobDetail {
  id: string
  title: string
  company: string | null
  location: string | null
  date: string | null
  url: string
  description: string | null
  deadline: string | null
  department: string | null
}

function firstMatch(html: string, re: RegExp): string | null {
  const match = re.exec(html)
  return match ? htmlToText(match[1]) || null : null
}

export function companyForTarget(target: DetailTarget, employers: Employer[]): string | null {
  if (target.kind === "ext" && target.code && target.customer) {
    const needle = `${target.code}/${target.customer}`.toLowerCase()
    const row = employers.find((employer) => employer.atsRef.toLowerCase().includes(needle))
    if (row) return row.name || null
  }
  if (target.kind === "attract") {
    const slug = new URL(target.url).hostname.split(".")[0]
    const row = employers.find((employer) => websiteSlug(employer.website) === slug)
    if (row) return row.name || null
  }
  return null
}

export function parseExtDetail(html: string, target: DetailTarget, companyHint: string | null = null): JobDetail {
  const pageTitle = firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i)
  const companyFromTitle = pageTitle && pageTitle.includes("|")
    ? pageTitle.split("|")[0].trim()
    : null

  const title =
    firstMatch(html, /<h1[^>]*id=["']jobad-heading["'][^>]*>([\s\S]*?)<\/h1>/i) ??
    firstMatch(html, /<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ??
    pageTitle ??
    "(untitled)"

  const location = firstMatch(html, /<p[^>]*class=["'][^"']*extid[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)
  const descriptionHtml = extractDivContent(html, "jobad-body")

  const deadline = firstMatch(
    html,
    /(?:Sista ansökningsdag|Søknadsfrist|Application deadline|Viimeinen hakupäivämäärä)\s*:?\s*([\s\S]{0,40}?\d{4})/i,
  )

  return {
    id: target.url,
    title,
    company: companyHint || companyFromTitle,
    location,
    date: null,
    url: target.url,
    description: descriptionHtml ? htmlToText(descriptionHtml) || null : null,
    deadline,
    department: null,
  }
}

export function parseAttractDetail(html: string, target: DetailTarget, companyHint: string | null = null): JobDetail {
  const article = html.match(/<article[^>]*class=["'][^"']*at-job-details[^"']*["'][^>]*>([\s\S]*?)<\/article>/i)?.[1]
  const scope = article ?? html

  const title = firstMatch(scope, /<header[^>]*>[\s\S]*?<h2[^>]*>([\s\S]*?)<\/h2>/i) ?? firstMatch(scope, /<h2[^>]*>([\s\S]*?)<\/h2>/i)
  const location = firstMatch(scope, /<span[^>]*class=["'][^"']*at-location[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)
  const department = firstMatch(scope, /<span[^>]*class=["'][^"']*at-department[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)
  const deadlineRaw = firstMatch(
    scope,
    /<span[^>]*class=["'][^"']*at-application-date[^"']*["'][^>]*>([\s\S]*?)<\/span>/i,
  )
  const deadline = deadlineRaw
    ? deadlineRaw.replace(/^(Sista ansökningsdag|Søknadsfrist|Application deadline|Viimeinen hakupäivämäärä)\s*:?\s*/i, "")
    : null

  const descriptionHtml = extractDivContent(scope, "at-job-body")

  return {
    id: target.url,
    title: title ?? "(untitled)",
    company: companyHint,
    location,
    date: null,
    url: target.url,
    description: descriptionHtml ? htmlToText(descriptionHtml) || null : null,
    deadline,
    department,
  }
}
