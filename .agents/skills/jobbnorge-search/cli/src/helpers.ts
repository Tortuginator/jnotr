// Data sources for Jobbnorge:
//   - Public search API: https://publicapi.jobbnorge.no/v1/Jobs (JSON, no auth)
//   - Public county/municipality list: https://publicapi.jobbnorge.no/v1/County
//   - Job detail metadata: https://id.jobbnorge.no/api/joblisting/job-info
//   - Job detail content:  https://id.jobbnorge.no/api/joblisting?jobId=&languageId=
//
// The site itself is an Angular shell; the detail HTML does not contain the
// description. The XHR endpoints above are what the page calls, and they are
// public. No runtime dependencies: Bun + fetch + regex.

import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

export const API_BASE = "https://publicapi.jobbnorge.no"
export const ID_API_BASE = "https://id.jobbnorge.no/api"
export const SITE_BASE = "https://www.jobbnorge.no"
export const UA = "Mozilla/5.0 (compatible; jobbnorge-search-cli/1.0)"

/** Repo root, resolved from cli/src/helpers.ts (five levels up). */
export const REPO_ROOT = resolve(import.meta.dir, "../../../../..")

export function writeError(error: string, code: string): void {
  process.stderr.write(JSON.stringify({ error, code }) + "\n")
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function jitter(): number {
  return Math.floor(Math.random() * 500)
}

/**
 * Fetch JSON with exponential backoff on 429/5xx. Returns null on 404 so a
 * caller can turn it into NOT_FOUND instead of crashing. Network errors are
 * retried as well; a non-JSON 2xx response is an error because a consent or
 * block page must not be mistaken for an empty result set.
 */
export async function jsonFetch<T>(url: string): Promise<T | null> {
  const maxRetries = 6
  let delay = 500

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response: Response
    try {
      response = await fetch(url, {
        headers: {
          "User-Agent": UA,
          Accept: "application/json",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(20000),
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
      const retryAfter = Number(response.headers.get("retry-after"))
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : delay + jitter()
      await sleep(wait)
      delay = Math.min(delay * 2, 8000)
      continue
    }

    if (response.status === 404) return null
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status} ${response.statusText}`)
    }

    const text = await response.text()
    try {
      return JSON.parse(text) as T
    } catch {
      throw new Error(`Response was not valid JSON from ${url}`)
    }
  }

  throw new Error("Request failed after max retries")
}

/* ------------------------------------------------------------------ */
/* HTML hygiene: copied from linkedin-search/cli/src/helpers.ts        */
/* ------------------------------------------------------------------ */

function numericEntity(cp: number): string {
  return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ""
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "\u2014",
  ndash: "\u2013",
  hellip: "\u2026",
  laquo: "\u00ab",
  raquo: "\u00bb",
  oslash: "\u00f8",
  Oslash: "\u00d8",
  aelig: "\u00e6",
  AElig: "\u00c6",
  aring: "\u00e5",
  Aring: "\u00c5",
  eacute: "\u00e9",
  Eacute: "\u00c9",
  ouml: "\u00f6",
  Ouml: "\u00d6",
  auml: "\u00e4",
  Auml: "\u00c4",
}

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&([a-zA-Z][a-zA-Z0-9]+);/g, (m, name: string) => NAMED_ENTITIES[name] ?? NAMED_ENTITIES[name.toLowerCase()] ?? m)
    .replace(/&#(\d+);/g, (_, dec) => numericEntity(parseInt(dec, 10)))
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, hex) => numericEntity(parseInt(hex, 16)))
}

const INVISIBLE_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFE00-\uFE0F\uFEFF\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu

/** Strip characters a posting's reader never sees from every string, recursively. */
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

/** Flatten a short HTML fragment (title, summary) to one clean line. */
export function cleanText(html: string): string {
  const text = decodeHtmlEntities(visibleHtml(html).replace(/<[^>]+>/g, " "))
  return text.replace(/\s+/g, " ").trim()
}

/** Convert a description fragment to readable text, preserving paragraph and list breaks. */
export function htmlToText(html: string): string {
  if (!html) return ""
  const withBreaks = visibleHtml(html)
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*li\b[^>]*>/gi, "\n\u2022 ")
    .replace(/<\/(p|li|ul|ol|div|h[1-6]|tr|section|article)>/gi, "\n")
  const text = decodeHtmlEntities(withBreaks.replace(/<[^>]+>/g, " "))
  const lines = text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return lines
}

/* ------------------------------------------------------------------ */
/* Date normalisation                                                  */
/* ------------------------------------------------------------------ */

/** Normalise Jobbnorge's "dd.mm.yyyy" and "$date('yyyy-mm-dd ...')" to ISO date. */
export function normalizeDate(value: string | null | undefined): string | null {
  if (!value) return null
  const s = String(value).trim()

  const apiDate = s.match(/\$date\('([^']+)'\)/)
  if (apiDate) return apiDate[1].slice(0, 10)

  const dmy = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/)
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`

  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/)
  if (iso) return iso[1]

  return null
}

/* ------------------------------------------------------------------ */
/* Employer registry (CSV)                                             */
/* ------------------------------------------------------------------ */

/** Minimal RFC-4180-style CSV reader: quotes, doubled quotes and CRLF. */
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

    if (c === '"') inQuotes = true
    else if (c === ",") {
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

export interface EmployerEntry {
  name: string
  keys: string[]
  tokenKeys: string[]
}

export interface EmployerIndex {
  entries: EmployerEntry[]
  resolve(employer: string | null | undefined): string | null
}

const LEGAL_SUFFIXES = new Set(["as", "asa", "hf", "sf", "sa", "ab", "ltd", "inc", "plc", "oy", "oyj"])

function fold(value: string): string {
  return value
    .normalize("NFC")
    .toLocaleLowerCase("nb")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function tokenList(value: string): string[] {
  return fold(value)
    .split(" ")
    .filter((t) => t.length > 0 && !LEGAL_SUFFIXES.has(t))
}

function tokenKey(value: string): string {
  return tokenList(value).sort().join(" ")
}

/**
 * Build an employer alias index from one or more registry CSVs. Matching order:
 * exact name/alias, same token set (handles NTNU's word order), then containment
 * of a multi-word name (handles "Trondheim kommune" vs a longer unit name).
 * Single-token containment is deliberately not used: "SINTEF" must not absorb
 * "SINTEF Ocean".
 */
export function buildEmployerIndex(csvTexts: string[]): EmployerIndex {
  const entries: EmployerEntry[] = []

  for (const text of csvTexts) {
    const rows = parseCsv(text)
    if (rows.length === 0) continue
    const header = rows[0].map((h) => h.replace(/^\uFEFF/, "").trim().toLowerCase())
    const nameIdx = header.indexOf("name")
    const aliasesIdx = header.indexOf("aliases")
    if (nameIdx === -1) continue

    for (const row of rows.slice(1)) {
      const name = (row[nameIdx] ?? "").trim()
      if (!name) continue
      const aliases =
        aliasesIdx >= 0
          ? (row[aliasesIdx] ?? "")
              .split("|")
              .map((a) => a.trim())
              .filter(Boolean)
          : []
      entries.push({
        name,
        keys: [name, ...aliases].map(fold).filter(Boolean),
        tokenKeys: [name, ...aliases].map(tokenKey).filter(Boolean),
      })
    }
  }

  return {
    entries,
    resolve(employer: string | null | undefined): string | null {
      if (!employer) return null
      const folded = fold(employer)
      if (!folded) return employer.trim() || null
      const tk = tokenKey(employer)

      let best: { name: string; score: number } | null = null
      for (const entry of entries) {
        let score = 0
        if (entry.keys.includes(folded)) score = 4
        else if (entry.tokenKeys.includes(tk)) score = 3
        else if (entry.keys.some((k) => k.split(" ").length >= 2 && (folded.includes(k) || k.includes(folded)))) score = 2

        if (score > (best?.score ?? 0)) best = { name: entry.name, score }
      }

      return best ? best.name : employer.trim()
    },
  }
}

/** Load job_scraper/employers.csv first, then the seed file for names it lacks. */
export function loadEmployerIndex(repoRoot: string = REPO_ROOT): EmployerIndex {
  const paths = [
    resolve(repoRoot, "job_scraper/employers.csv"),
    resolve(repoRoot, "trondheim-patches/employers.seed.csv"),
  ]
  const texts: string[] = []
  for (const p of paths) {
    try {
      if (existsSync(p)) texts.push(readFileSync(p, "utf8"))
    } catch {
      // A missing or unreadable registry is not fatal: the API employer is used.
    }
  }
  return buildEmployerIndex(texts)
}

/* ------------------------------------------------------------------ */
/* Location resolution                                                 */
/* ------------------------------------------------------------------ */

export interface Municipality {
  id: number
  name: string
}

export interface County {
  id: number
  name: string
  municipality: Municipality[] | null
}

export interface LocationFilter {
  municipalities: number[]
  counties: number[]
  label: string
}

/** The five municipalities in the Trondheim commute area (plan WP2). */
export const AREA_MUNICIPALITIES = [5001, 5031, 5028, 5029, 5035] as const

export class LocationError extends Error {}

function foldPlace(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}+/gu, "")
    .toLowerCase()
    .replace(/ø/g, "o")
    .replace(/æ/g, "ae")
    .replace(/å/g, "a")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

function placeCandidates(value: string): string[] {
  const out = new Set<string>()
  const base = foldPlace(value)
  if (!base) return []
  out.add(base)
  for (const suffix of ["kommune", "fylke", "norway", "norge"]) {
    if (base.endsWith(` ${suffix}`)) out.add(base.slice(0, -(suffix.length + 1)).trim())
  }
  return [...out].filter(Boolean)
}

/**
 * Resolve a --location value against the live county/municipality list.
 * Accepts "area" (the five commute municipalities), a municipality name, a
 * county name, a 3- or 4-digit municipality code or a 2-digit county code.
 */
export function resolveLocation(input: string, counties: County[]): LocationFilter {
  const raw = input.trim()
  if (!raw) throw new LocationError("--location requires a non-empty value")

  const folded = foldPlace(raw)
  if (folded === "area" || folded === "trondheim area" || folded === "trondheimsomradet" || folded === "commute area") {
    return {
      municipalities: [...AREA_MUNICIPALITIES],
      counties: [],
      label: "Trondheim area (5001, 5031, 5028, 5029, 5035)",
    }
  }

  if (/^\d{3,4}$/.test(raw)) {
    return { municipalities: [Number(raw)], counties: [], label: raw }
  }
  if (/^\d{2}$/.test(raw)) {
    return { municipalities: [], counties: [Number(raw)], label: raw }
  }

  const candidates = placeCandidates(raw)

  for (const county of counties) {
    for (const municipality of county.municipality ?? []) {
      if (candidates.includes(foldPlace(municipality.name))) {
        return { municipalities: [municipality.id], counties: [], label: municipality.name }
      }
    }
  }

  for (const county of counties) {
    if (candidates.includes(foldPlace(county.name))) {
      return { municipalities: [], counties: [county.id], label: county.name }
    }
  }

  throw new LocationError(
    `Unknown location "${input}". Use "area", a Norwegian municipality name (e.g. Trondheim), a county name (e.g. Trøndelag), or a numeric code.`,
  )
}

export interface AreaMunicipality {
  code: string
  name: string
  aliases?: string[]
  places?: string[]
}

export interface AreaFile {
  municipalities: AreaMunicipality[]
}

/** Read job_scraper/area.json for the place names that are not municipality names. */
export function loadAreaFile(repoRoot: string = REPO_ROOT): AreaFile | null {
  const path = resolve(repoRoot, "job_scraper/area.json")
  try {
    if (!existsSync(path)) return null
    const parsed = JSON.parse(readFileSync(path, "utf8")) as AreaFile
    return Array.isArray(parsed?.municipalities) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Names that a result's `location` may legitimately use for a resolved filter.
 * Includes municipality names, the selected county's municipalities, and the
 * commute-area aliases/places so Hommelvik still matches Malvik.
 */
export function locationNamesForFilter(
  filter: LocationFilter,
  counties: County[],
  area: AreaFile | null = loadAreaFile(),
): string[] {
  const names = new Set<string>()
  for (const county of counties) {
    if (filter.counties.includes(county.id)) {
      names.add(foldPlace(county.name))
      for (const municipality of county.municipality ?? []) names.add(foldPlace(municipality.name))
    }
    for (const municipality of county.municipality ?? []) {
      if (filter.municipalities.includes(municipality.id)) names.add(foldPlace(municipality.name))
    }
  }
  for (const municipality of area?.municipalities ?? []) {
    if (!filter.municipalities.includes(Number(municipality.code))) continue
    for (const name of [municipality.name, ...(municipality.aliases ?? []), ...(municipality.places ?? [])]) {
      const folded = foldPlace(name)
      if (folded) names.add(folded)
    }
  }
  return [...names].filter(Boolean)
}

function placeTokens(value: string): string[] {
  return foldPlace(value).split(" ").filter(Boolean)
}

/** Whole-token phrase match; prevents "Venn" matching "Vennesla". */
export function locationMatchesNames(location: string | null, names: string[]): boolean {
  if (!location) return false
  const haystack = placeTokens(location)
  if (haystack.length === 0) return false
  for (const name of names) {
    const wanted = placeTokens(name)
    if (wanted.length === 0) continue
    for (let i = 0; i + wanted.length <= haystack.length; i++) {
      if (wanted.every((token, j) => haystack[i + j] === token)) return true
    }
  }
  return false
}


let countyCache: County[] | null = null

/** Fetch the county/municipality list once per process. */
export async function fetchCounties(): Promise<County[]> {
  if (countyCache) return countyCache
  const data = await jsonFetch<County[]>(`${API_BASE}/v1/County`)
  if (!data) throw new Error("Could not load Jobbnorge's county list")
  countyCache = data
  return data
}

/* ------------------------------------------------------------------ */
/* Search results                                                      */
/* ------------------------------------------------------------------ */

export interface RawJob {
  id?: number | string | null
  employer?: string | null
  title?: string | null
  link?: string | null
  location?: string | null
  deadline?: string | null
  jobScope?: string | null
  jobDuration?: string | null
  summary?: string | null
}

export interface JobResult {
  id: string
  title: string
  company: string | null
  location: string | null
  date: string | null
  url: string
  deadline: string | null
  jobScope: string | null
  jobDuration: string | null
  summary: string | null
}

export function parseJob(raw: RawJob, employers: EmployerIndex): JobResult | null {
  if (raw.id === undefined || raw.id === null || String(raw.id).trim() === "") return null
  const id = String(raw.id)
  const title = raw.title ? cleanText(raw.title) : ""
  if (!title) return null

  const employer = raw.employer ? cleanText(raw.employer) : null
  return {
    id,
    title,
    company: employers.resolve(employer),
    location: raw.location ? cleanText(raw.location) : null,
    // Jobbnorge's search payload carries no publication date. A null date is
    // honest; --jobage maps to the API's Day/Week period instead.
    date: null,
    url: raw.link?.trim() || `${SITE_BASE}/ledige-stillinger/stilling/${id}`,
    deadline: normalizeDate(raw.deadline),
    jobScope: raw.jobScope ? cleanText(raw.jobScope) : null,
    jobDuration: raw.jobDuration ? cleanText(raw.jobDuration) : null,
    summary: raw.summary ? cleanText(raw.summary) : null,
  }
}

export function parseSearchResults(raw: RawJob[], employers: EmployerIndex): JobResult[] {
  return raw.map((job) => parseJob(job, employers)).filter((job): job is JobResult => job !== null)
}

export function dedupeById(jobs: RawJob[]): RawJob[] {
  const seen = new Set<string>()
  const out: RawJob[] = []
  for (const job of jobs) {
    const id = job.id === undefined || job.id === null ? "" : String(job.id)
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(job)
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Detail                                                              */
/* ------------------------------------------------------------------ */

export interface Contact {
  name: string | null
  email: string | null
  phone: string | null
  title: string | null
}

export interface RawContact {
  name?: string | null
  email?: string | null
  phone?: string | null
  title?: string | null
}

export interface WorkPlace {
  adress?: string | null
  area?: string | null
  zip?: string | null
  municipality?: string | null
}

export interface JobInfo {
  id?: number
  employerName?: string | null
  deadlineOn?: string | null
  jobScope?: string | null
  jobDuration?: string | null
  workPlace?: WorkPlace[] | null
  contacts?: RawContact[] | null
}

export interface JobComponent {
  heading?: string | null
  text?: string | null
  typeId?: number
  orderId?: number
}

export interface JobContent {
  components?: JobComponent[] | null
  activeLanguages?: number[] | null
  isPublished?: boolean | null
  positionCount?: number | null
  contacts?: RawContact[] | null
}

export interface JobDetail {
  id: string
  title: string
  company: string | null
  location: string | null
  date: string | null
  url: string
  deadline: string | null
  employmentType: string | null
  jobScope: string | null
  jobDuration: string | null
  positionCount: number | null
  description: string | null
  contacts: Contact[]
  isActive: boolean | null
  language: string | null
}

const LANGUAGES: Record<number, string> = { 1: "nb", 2: "en", 3: "nn", 4: "se" }

function cleanContacts(raw: RawContact[] | null | undefined): Contact[] {
  return (raw ?? [])
    .map((c) => ({
      name: c.name ? cleanText(c.name) || null : null,
      email: c.email ? cleanText(c.email) || null : null,
      phone: c.phone ? cleanText(c.phone) || null : null,
      title: c.title ? cleanText(c.title) || null : null,
    }))
    .filter((c) => c.name || c.email || c.phone)
}

function buildDescription(components: JobComponent[] | null | undefined, title: string): string | null {
  const parts: string[] = []
  for (const component of components ?? []) {
    const heading = component.heading ? cleanText(component.heading) : ""
    const text = component.text ? htmlToText(component.text) : ""
    if (!heading && !text) continue

    if (heading && heading.toLocaleLowerCase("nb") !== title.toLocaleLowerCase("nb")) {
      parts.push(heading)
    }
    if (text) parts.push(text)
  }

  const description = parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim()
  return description || null
}

export function parseJobDetail(
  id: string,
  info: JobInfo | null,
  content: JobContent,
  employers: EmployerIndex,
  language: number | null,
): JobDetail {
  const components = content.components ?? []
  const title =
    cleanText(components.find((c) => c.typeId === 0 && c.heading)?.heading ?? "") ||
    cleanText(components.find((c) => c.heading)?.heading ?? "") ||
    "(untitled)"

  const places = [...new Set(
    (info?.workPlace ?? [])
      .map((w) => cleanText(w.area ?? w.municipality ?? ""))
      .filter(Boolean),
  )]
  const location = places.length > 0 ? places.join(", ") : null

  const employer = info?.employerName ? cleanText(info.employerName) : null
  const jobScope = info?.jobScope ? cleanText(info.jobScope) : null
  const jobDuration = info?.jobDuration ? cleanText(info.jobDuration) : null
  const employmentType = [jobScope, jobDuration].filter(Boolean).join(" / ") || null

  return {
    id,
    title,
    company: employers.resolve(employer),
    location,
    date: null,
    url: `${SITE_BASE}/ledige-stillinger/stilling/${id}`,
    deadline: normalizeDate(info?.deadlineOn),
    employmentType,
    jobScope,
    jobDuration,
    positionCount: content.positionCount ?? null,
    description: buildDescription(components, title),
    contacts: cleanContacts(info?.contacts?.length ? info.contacts : content.contacts),
    isActive: content.isPublished ?? null,
    language: language !== null ? LANGUAGES[language] ?? null : null,
  }
}
