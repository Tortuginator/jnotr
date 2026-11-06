import {
  apiGetJson,
  detailUrl,
  enabledEmployers,
  mapDetail,
  normalizeDetailInput,
  resolveSlug,
  stripInvisible,
  writeError,
  type FetchLike,
  type JobDetail,
  type SRDetail,
} from "../helpers.js"

export interface DetailOpts {
  id: string
  format: "json" | "plain"
}

export interface DetailDeps {
  fetchImpl?: FetchLike
}

async function fetchWithSlug(
  slug: string,
  id: string,
  fetchImpl: FetchLike,
): Promise<{ slug: string; detail: SRDetail } | null> {
  const detail = await apiGetJson<SRDetail>(detailUrl(slug, id), fetchImpl)
  return detail ? { slug, detail } : null
}

/** A bare numeric ID is looked up across the enabled registry slugs. */
async function findAcrossRegistry(
  id: string,
  fetchImpl: FetchLike,
): Promise<{ slug: string; detail: SRDetail } | null> {
  const employers = enabledEmployers("smartrecruiters")
  const slugs = new Map<string, string>()
  for (const employer of employers) {
    try {
      slugs.set(resolveSlug(employer), employer.name)
    } catch {
      // Bad registry rows are search-time errors; detail simply skips them.
    }
  }
  const entries = [...slugs.entries()]
  const out: Array<{ slug: string; detail: SRDetail } | null> = new Array(entries.length)
  let next = 0
  let firstError: unknown = null
  async function run(): Promise<void> {
    for (;;) {
      const i = next++
      if (i >= entries.length) return
      try {
        out[i] = await fetchWithSlug(entries[i][0], id, fetchImpl)
      } catch (error) {
        // A bare ID belongs to exactly one company; the API answers 400 when
        // the ID is tried against another company identifier. Keep scanning.
        if (firstError === null) firstError = error
        out[i] = null
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, entries.length) }, () => run()))
  const found = out.find((v): v is { slug: string; detail: SRDetail } => v !== null)
  if (!found && firstError) throw firstError
  return found ?? null
}

export async function runDetail(opts: DetailOpts, deps: DetailDeps = {}): Promise<number> {
  const parsed = normalizeDetailInput(opts.id)
  if (!parsed) {
    writeError(`Could not parse a SmartRecruiters job ID or URL from "${opts.id}"`, "BAD_ID")
    return 1
  }
  const fetchImpl = deps.fetchImpl ?? fetch
  try {
    const found = parsed.slug
      ? await fetchWithSlug(parsed.slug, parsed.id, fetchImpl)
      : await findAcrossRegistry(parsed.id, fetchImpl)
    if (!found) {
      writeError("Job not found", "NOT_FOUND")
      return 1
    }
    const employer = enabledEmployers("smartrecruiters").find((e) => {
      try {
        return resolveSlug(e) === found.slug
      } catch {
        return false
      }
    })
    const job = stripInvisible(mapDetail(found.detail, employer?.name ?? null, found.slug)) as JobDetail

    if (opts.format === "plain") {
      const lines = [
        job.title,
        `${job.company || "—"} · ${job.location || "—"} · ${job.date || "—"}`,
        job.refNumber ? `Reference: ${job.refNumber}` : "",
        job.department ? `Department: ${job.department}` : "",
        job.employmentType ? `Employment: ${job.employmentType}` : "",
        job.industry ? `Industry: ${job.industry}` : "",
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
