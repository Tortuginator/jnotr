import {
  enabledEmployers,
  fetchTarget,
  loadArea,
  paginate,
  resolveTargets,
  stripInvisible,
  writeError,
  type FeedTarget,
  type FetchLike,
  type JobResult,
  type LocationMapped,
} from "../helpers.js"

export interface SearchOpts {
  query?: string
  location?: string
  jobage?: number
  page: number
  limit?: number
  format: "json" | "table" | "plain"
}

export interface MetaError {
  employer: string
  error: string
}

export interface SearchDeps {
  fetchImpl?: FetchLike
}

export interface SearchOutcome {
  results: JobResult[]
  errors: MetaError[]
  totalMatched: number
}

const CONCURRENCY = 4

async function pool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: unknown }>> {
  const out: Array<{ ok: true; value: R } | { ok: false; error: unknown }> = new Array(items.length)
  let next = 0
  async function run(): Promise<void> {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      try {
        out[i] = { ok: true, value: await worker(items[i]) }
      } catch (error) {
        out[i] = { ok: false, error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()))
  return out
}

export async function searchAll(opts: SearchOpts, deps: SearchDeps = {}): Promise<SearchOutcome> {
  const employers = enabledEmployers("hrmanager")
  const area = loadArea()
  const fetchImpl = deps.fetchImpl ?? fetch

  const resolved = await resolveTargets(employers, fetchImpl)
  const errors: MetaError[] = [...resolved.errors]
  const settled = await pool<FeedTarget, LocationMapped[]>(resolved.targets, CONCURRENCY, (target) =>
    fetchTarget(target, area, opts, fetchImpl),
  )

  const byKey = new Map<string, LocationMapped>()
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i]
    if (!outcome.ok) {
      errors.push({
        employer: resolved.targets[i].employerName,
        error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
      })
      continue
    }
    for (const entry of outcome.value) {
      byKey.set(entry.result.url, entry)
    }
  }

  const all = [...byKey.values()].sort((a, b) => (b.result.date ?? "").localeCompare(a.result.date ?? ""))
  const results = paginate(
    all.map((entry) => entry.result),
    opts.page,
    opts.limit,
  )
  return { results, errors, totalMatched: all.length }
}

function renderTable(results: JobResult[]): string {
  if (results.length === 0) return "No results."
  const rows = results.map((r) => {
    const title = (r.title || "").slice(0, 42).padEnd(42)
    const company = (r.company || "—").slice(0, 26).padEnd(26)
    const loc = (r.location || "—").slice(0, 28).padEnd(28)
    return `${r.id.padEnd(10)} ${title} ${company} ${loc} ${r.date || "—"}`
  })
  const header =
    "ID".padEnd(10) + " " + "TITLE".padEnd(42) + " " + "COMPANY".padEnd(26) + " " + "LOCATION".padEnd(28) + " DATE"
  return [header, "-".repeat(header.length), ...rows].join("\n")
}

export async function runSearch(opts: SearchOpts, deps: SearchDeps = {}): Promise<number> {
  try {
    const outcome = await searchAll(opts, deps)
    const results = stripInvisible(outcome.results)
    if (opts.format === "table") {
      process.stdout.write(renderTable(results) + "\n")
      if (outcome.errors.length > 0) {
        process.stdout.write(`\n(${outcome.errors.length} employer(s) failed; use --format json for meta.errors)\n`)
      }
    } else if (opts.format === "plain") {
      process.stdout.write(
        results
          .map(
            (r) =>
              `${r.title}\n  ${r.company || "—"} · ${r.location || "—"} · ${r.date || "—"}\n  id: ${r.id}\n  ${r.url}`,
          )
          .join("\n\n") + "\n",
      )
      if (outcome.errors.length > 0) {
        process.stdout.write(`\n(${outcome.errors.length} employer(s) failed; use --format json for meta.errors)\n`)
      }
    } else {
      process.stdout.write(
        JSON.stringify(
          stripInvisible({
            meta: {
              count: results.length,
              page: opts.page,
              totalMatched: outcome.totalMatched,
              errors: outcome.errors,
            },
            results,
          }),
          null,
          2,
        ) + "\n",
      )
    }
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "SEARCH_FAILED")
    return 1
  }
}
