import {
  enabledEmployers,
  feedUrl,
  getText,
  loadArea,
  normalizeDetailInput,
  parseDetailHtml,
  parseRss,
  projectIdFromUrl,
  resolveTargets,
  stripInvisible,
  writeError,
  type Area,
  type FetchLike,
  type JobDetail,
} from "../helpers.js"

export interface DetailOpts {
  id: string
  format: "json" | "plain"
}

export interface DetailDeps {
  fetchImpl?: FetchLike
}

async function findInFeed(customer: string, id: string, fetchImpl: FetchLike): Promise<string | null> {
  const xml = await getText(feedUrl(customer), fetchImpl)
  if (!xml) return null
  for (const item of parseRss(xml)) {
    if (item.guid === id || projectIdFromUrl(item.link) === id || item.link.includes(id)) return item.link
  }
  return null
}

async function findPostingUrl(input: string, fetchImpl: FetchLike): Promise<string | null> {
  const parsed = normalizeDetailInput(input)
  if (!parsed) throw new Error("BAD_ID")
  if (parsed.url) return parsed.url
  if (parsed.customer) return findInFeed(parsed.customer, parsed.id, fetchImpl)
  const id = parsed.id

  const { targets } = await resolveTargets(enabledEmployers("hrmanager"), fetchImpl)
  const out: Array<string | null> = new Array(targets.length)
  let next = 0
  async function run(): Promise<void> {
    for (;;) {
      const i = next++
      if (i >= targets.length) return
      out[i] = await findInFeed(targets[i].customer, id, fetchImpl)
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, targets.length) }, () => run()))
  return out.find((url): url is string => url !== null) ?? null
}

export async function runDetail(opts: DetailOpts, deps: DetailDeps = {}): Promise<number> {
  const fetchImpl = deps.fetchImpl ?? fetch
  let url: string | null
  try {
    const normalized = normalizeDetailInput(opts.id)
    if (!normalized) {
      writeError(`Could not parse an HR Manager posting ID or URL from "${opts.id}"`, "BAD_ID")
      return 1
    }
    url = await findPostingUrl(opts.id, fetchImpl)
  } catch (e) {
    if (e instanceof Error && e.message === "BAD_ID") {
      writeError(`Could not parse an HR Manager posting ID or URL from "${opts.id}"`, "BAD_ID")
      return 1
    }
    writeError(e instanceof Error ? e.message : String(e), "DETAIL_FAILED")
    return 1
  }

  if (!url) {
    writeError("Job not found", "NOT_FOUND")
    return 1
  }

  try {
    const html = await getText(url, fetchImpl)
    if (!html) {
      writeError("Job not found", "NOT_FOUND")
      return 1
    }
    const normalized = normalizeDetailInput(opts.id)
    const id = normalized?.id ?? projectIdFromUrl(url) ?? url
    let area: Area | undefined
    try {
      area = loadArea()
    } catch {
      area = undefined
    }
    const job = stripInvisible(parseDetailHtml(html, id, url, area)) as JobDetail

    if (opts.format === "plain") {
      const lines = [
        job.title,
        `${job.company || "—"} · ${job.location || "—"} · ${job.date || "—"}`,
        "",
        job.description || "(no description)",
        "",
        `URL: ${job.url}`,
      ].filter((line) => line !== "")
      process.stdout.write(lines.join("\n") + "\n")
    } else {
      process.stdout.write(JSON.stringify(job, null, 2) + "\n")
    }
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "DETAIL_FAILED")
    return 1
  }
}
