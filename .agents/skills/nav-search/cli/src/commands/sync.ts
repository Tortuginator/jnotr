import { normalizeDetail } from "./detail.js"
import {
  DEFAULT_FEED_BASE,
  HttpError,
  asRecord,
  isoDateTime,
  jsonFetch,
  loadEmployers,
  mergeRecord,
  parseFeedPage,
  readCacheFile,
  readStateFile,
  recordFromFeedItem,
  resolvePaths,
  str,
  writeCacheFile,
  writeError,
  writeStateFile,
  type EmployerRow,
  type NormRecord,
  type Paths,
  type SyncState,
} from "../helpers.js"

export interface SyncOptions {
  sinceDays: number
  maxPages: number
  dryRun: boolean
  token: string
  /** Fetch full descriptions for up to N new active ads (0 disables). */
  detailsLimit?: number
  paths?: Paths
  employers?: EmployerRow[]
  feedBaseUrl?: string
  now?: number
}

export interface SyncResult {
  dry_run: boolean
  since: string
  start: string
  pages: number
  items: number
  upserted: number
  active: number
  details_fetched: number
  details_failed: number
  cache_size: number
  cursor: string | null
  newest: string | null
  reached_end: boolean
  cache_path: string
  state_path: string
}

const DAY_MS = 86400000
const HOUR_MS = 3600000

function itemTimestamp(item: Record<string, unknown>): number | null {
  const entry = asRecord(item._feed_entry) ?? {}
  const date = isoDateTime(str(item.date_modified) ?? str(entry.sistEndret))
  if (!date) return null
  const time = Date.parse(date)
  return Number.isFinite(time) ? time : null
}

function itemIso(item: Record<string, unknown>): string | null {
  const entry = asRecord(item._feed_entry) ?? {}
  return isoDateTime(str(item.date_modified) ?? str(entry.sistEndret))
}

function feedBase(): string {
  return (process.env.NAV_FEED_BASE_URL || DEFAULT_FEED_BASE).replace(/\/+$/, "")
}

function absoluteUrl(url: string, base: string): string {
  return new URL(url, base.endsWith("/") ? base : `${base}/`).toString()
}

export async function performSync(opts: SyncOptions): Promise<SyncResult> {
  if (!opts.token) throw new Error("NAV_API_TOKEN is not set")
  const paths = opts.paths ?? resolvePaths()
  const employers = opts.employers ?? loadEmployers(paths.employersPath)
  const base = (opts.feedBaseUrl ?? feedBase()).replace(/\/+$/, "")
  const feedUrl = `${base}/api/v1/feed`
  const now = opts.now ?? Date.now()
  const cutoff = now - opts.sinceDays * DAY_MS

  const state: SyncState = readStateFile(paths.statePath)
  const records = readCacheFile(paths.cachePath)
  const seenPageIds = new Set(state.seen_page_ids)
  let lastPageId = state.last_page_id
  let newest = state.newest_item_date
  let cursor = state.last_item_date
  let pages = 0
  let items = 0
  let upserted = 0
  let reachedEnd = false
  let startMs = cutoff

  const ingest = (pageItems: Record<string, unknown>[], cutoffMs: number): { max: number | null; maxIso: string | null; count: number } => {
    let max: number | null = null
    let maxIso: string | null = null
    let count = 0
    for (const item of pageItems) {
      const time = itemTimestamp(item)
      if (time !== null && time < cutoffMs) continue
      const entry = asRecord(item._feed_entry) ?? {}
      const uuid = str(entry.uuid) ?? str(item.id)
      if (!uuid) continue
      const record = recordFromFeedItem(item, employers, records.get(uuid))
      if (!record) continue
      const merged = mergeRecord(records.get(uuid), record)
      records.set(uuid, merged)
      items++
      upserted++
      count++
      if (time !== null && (max === null || time > max)) {
        max = time
        maxIso = itemIso(item)
      }
      if (merged.date_modified) {
        const mergedTime = Date.parse(merged.date_modified)
        if (Number.isFinite(mergedTime) && (max === null || mergedTime > max)) {
          max = mergedTime
          maxIso = merged.date_modified
        }
      }
    }
    return { max, maxIso, count }
  }

  const mergeNewest = (value: string | null): void => {
    if (!value) return
    if (!newest || Date.parse(value) > Date.parse(newest)) newest = value
  }

  // The feed is ordered oldest -> newest and its next_url walks forward in
  // time. On the first run we anchor at the newest page (?last) and estimate a
  // recent window, so a small --max-pages still returns current ads instead of
  // a week-old slice. The ?last page is merged immediately; the cursor still
  // tracks the end of the contiguous forward crawl so the next sync fills any
  // gap rather than skipping it.
  const firstRun = !state.last_item_date || records.size === 0
  if (firstRun) {
    const lastRaw = await jsonFetch<unknown>(`${feedUrl}?last`, { token: opts.token })
    if (lastRaw) {
      const lastPage = parseFeedPage(lastRaw)
      if (lastPage.id) {
        seenPageIds.add(lastPage.id)
        lastPageId = lastPage.id
      }
      const lastTimes = lastPage.items.map(itemTimestamp).filter((time): time is number => time !== null)
      const lastOldest = lastTimes.length ? Math.min(...lastTimes) : null
      const lastNewest = lastTimes.length ? Math.max(...lastTimes) : null
      for (const item of lastPage.items) mergeNewest(itemIso(item))
      ingest(lastPage.items, cutoff)

      if (lastOldest !== null && lastNewest !== null) {
        let span = HOUR_MS * 12
        if (lastPage.items.length >= 1000 && lastNewest > lastOldest) {
          span = lastNewest - lastOldest
        }
        span = Math.min(Math.max(span, HOUR_MS), 2 * DAY_MS)
        startMs = Math.max(cutoff, lastOldest - opts.maxPages * span)
      }
    }
  } else {
    const cursorTime = state.last_item_date ? Date.parse(state.last_item_date) : NaN
    startMs = Number.isFinite(cursorTime) ? Math.max(cutoff, cursorTime - HOUR_MS) : cutoff
  }

  let nextUrl: string | null = feedUrl
  let firstRequest = true
  let crawlMax: number | null = null
  let crawlMaxIso: string | null = null

  while (nextUrl && pages < opts.maxPages) {
    const raw = await jsonFetch<unknown>(nextUrl, {
      token: opts.token,
      ifModifiedSince: firstRequest ? new Date(startMs).toUTCString() : undefined,
    })
    firstRequest = false
    if (!raw) {
      reachedEnd = true
      break
    }
    const page = parseFeedPage(raw)

    // A page id already in state means this page was processed before. On the
    // first page that means no new changes; on a later page it means the walk
    // has caught up with the previous run.
    if (page.id && seenPageIds.has(page.id)) {
      break
    }
    if (page.id) {
      seenPageIds.add(page.id)
      lastPageId = page.id
    }

    pages++
    const pageTimes = page.items.map(itemTimestamp).filter((time): time is number => time !== null)
    if (pageTimes.length && Math.max(...pageTimes) < cutoff) {
      reachedEnd = true
      break
    }

    const result = ingest(page.items, cutoff)
    if (result.max !== null && (crawlMax === null || result.max > crawlMax)) {
      crawlMax = result.max
      crawlMaxIso = result.maxIso
    }
    for (const item of page.items) mergeNewest(itemIso(item))

    if (!page.next_url || !page.next_id) {
      reachedEnd = true
      break
    }
    nextUrl = absoluteUrl(page.next_url, base)
  }

  if (crawlMaxIso) cursor = crawlMaxIso
  else if (reachedEnd && state.last_item_date) cursor = state.last_item_date

  // The feed's content_text is the literal placeholder "Stillingsannonse", so
  // a query cannot match a description unless one is cached. Enrich the newest
  // active records that still lack one, in small concurrent batches. A failed
  // detail fetch leaves the feed record intact; it is not fatal to the sync.
  let detailsFetched = 0
  let detailsFailed = 0
  if (!opts.dryRun && opts.detailsLimit && opts.detailsLimit > 0) {
    const candidates = [...records.values()]
      .filter((record) => record.status === "ACTIVE" && !record.description)
      .sort((a, b) => (Date.parse(b.date_modified ?? "") || 0) - (Date.parse(a.date_modified ?? "") || 0))
      .slice(0, opts.detailsLimit)

    for (let i = 0; i < candidates.length; i += 4) {
      await Promise.all(
        candidates.slice(i, i + 4).map(async (record) => {
          try {
            const raw = await jsonFetch<unknown>(`${base}/api/v1/feedentry/${record.uuid}`, {
              token: opts.token,
            })
            if (!raw) {
              detailsFailed++
              return
            }
            const detail = normalizeDetail(raw, record.uuid, employers, record)
            records.set(record.uuid, {
              ...record,
              ...detail,
              description: detail.description ?? record.description,
            })
            detailsFetched++
          } catch {
            detailsFailed++
          }
        }),
      )
    }
  }

  const nextState: SyncState = {
    version: 1,
    last_sync: new Date(now).toISOString(),
    last_item_date: cursor,
    newest_item_date: newest,
    last_page_id: lastPageId,
    seen_page_ids: [...seenPageIds].slice(-100),
  }

  if (!opts.dryRun) {
    writeCacheFile(paths.cachePath, records)
    writeStateFile(paths.statePath, nextState)
  }

  let active = 0
  for (const record of records.values()) {
    if (record.status === "ACTIVE") active++
  }

  return {
    dry_run: opts.dryRun,
    since: new Date(cutoff).toISOString(),
    start: new Date(startMs).toISOString(),
    pages,
    items,
    upserted,
    active,
    details_fetched: detailsFetched,
    details_failed: detailsFailed,
    cache_size: records.size,
    cursor,
    newest,
    reached_end: reachedEnd,
    cache_path: paths.cachePath,
    state_path: paths.statePath,
  }
}

export async function runSync(opts: SyncOptions): Promise<number> {
  if (!opts.token) {
    writeError(
      "NAV_API_TOKEN is not set. Request a private token from NAV (nav.team.arbeidsplassen@nav.no) and export NAV_API_TOKEN before syncing.",
      "MISSING_CREDENTIALS",
    )
    return 1
  }
  try {
    const result = await performSync(opts)
    process.stdout.write(JSON.stringify({ meta: result }, null, 2) + "\n")
    return 0
  } catch (error) {
    if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
      writeError(
        "NAV rejected the bearer token (401/403). Check that NAV_API_TOKEN is a current, valid token.",
        "AUTH_FAILED",
      )
    } else {
      writeError(error instanceof Error ? error.message : String(error), "SYNC_FAILED")
    }
    return 1
  }
}
