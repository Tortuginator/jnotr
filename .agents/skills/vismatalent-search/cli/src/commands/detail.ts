import {
  GUID_FULL_RE,
  MAX_CONCURRENCY,
  MissingRegistryError,
  fetchJobs,
  fetchText,
  filterEmployers,
  jobUrl,
  loadRegistry,
  mapLimit,
  parseJob,
  resolveSiteGuid,
  stripInvisible,
  writeError,
  type Employer,
  type FetchInit,
  type JobResult,
  type VismaJob,
} from "../helpers.js"

export interface DetailOpts {
  id: string
  format: "json" | "plain"
}

export interface DetailTarget {
  siteGuid: string | null
  jobGuid: string
  url: string
}

export interface JobDetail extends JobResult {
  description: string | null
  employmentType: string | null
  department: string | null
  published: string | null
  endDate: string | null
  refNo: string | null
}

export interface SiteMatch {
  siteGuid: string
  company: string | null
  job: VismaJob
}

export interface DetailDeps {
  employers: Employer[] | null
  fetchText: (url: string, init?: FetchInit) => Promise<string | null>
}

export const defaultDetailDeps = (): DetailDeps => {
  const rows = loadRegistry()
  return {
    employers: rows === null ? null : filterEmployers(rows, "vismatalent"),
    fetchText,
  }
}

export function normalizeTarget(input: string): DetailTarget | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  if (GUID_FULL_RE.test(trimmed)) {
    const jobGuid = trimmed.toLowerCase()
    return { siteGuid: null, jobGuid, url: jobUrl(jobGuid) }
  }

  const pair = trimmed.match(/^([0-9a-f-]{36}):([0-9a-f-]{36})$/i)
  if (pair && GUID_FULL_RE.test(pair[1]) && GUID_FULL_RE.test(pair[2])) {
    const siteGuid = pair[1].toLowerCase()
    const jobGuid = pair[2].toLowerCase()
    return { siteGuid, jobGuid, url: jobUrl(jobGuid) }
  }

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  let parsed: URL
  try {
    parsed = new URL(withScheme)
  } catch {
    return null
  }
  if (!/(^|\.)vismatalent\.com$/i.test(parsed.hostname)) return null

  const rawJob = parsed.searchParams.get("guidAssignment") ?? parsed.searchParams.get("guidassignment")
  if (!rawJob || !GUID_FULL_RE.test(rawJob)) return null
  const jobGuid = rawJob.toLowerCase()

  let rawSite: string | null = parsed.searchParams.get("siteGuid") ?? parsed.searchParams.get("siteguid")
  if (!rawSite) {
    const segments = parsed.pathname.split("/").filter(Boolean)
    for (let i = segments.length - 1; i >= 0; i--) {
      if (GUID_FULL_RE.test(segments[i]) && segments[i].toLowerCase() !== jobGuid) {
        rawSite = segments[i]
        break
      }
    }
  }
  const siteGuid = rawSite && GUID_FULL_RE.test(rawSite) ? rawSite.toLowerCase() : null

  return { siteGuid, jobGuid, url: jobUrl(jobGuid) }
}

export async function findJob(
  target: DetailTarget,
  employers: Employer[] | null,
  fetcher: (url: string, init?: FetchInit) => Promise<string | null>,
): Promise<SiteMatch[]> {
  if (target.siteGuid) {
    const employer = (employers ?? []).find((row) => resolveSiteGuid(row.atsRef) === target.siteGuid)
    const jobs = await fetchJobs(target.siteGuid, fetcher)
    const job = jobs.find((item) => String(item.Guid ?? "").toLowerCase() === target.jobGuid)
    return job ? [{ siteGuid: target.siteGuid, company: employer?.name.trim() || null, job }] : []
  }

  if (employers === null) throw new MissingRegistryError()

  const sites: Array<{ siteGuid: string; company: string | null }> = []
  const seen = new Set<string>()
  for (const employer of employers) {
    const siteGuid = resolveSiteGuid(employer.atsRef)
    if (!siteGuid || seen.has(siteGuid)) continue
    seen.add(siteGuid)
    sites.push({ siteGuid, company: employer.name.trim() || null })
  }

  const matches: SiteMatch[] = []
  const failures: string[] = []
  await mapLimit(sites, MAX_CONCURRENCY, async (site) => {
    try {
      const jobs = await fetchJobs(site.siteGuid, fetcher)
      const job = jobs.find((item) => String(item.Guid ?? "").toLowerCase() === target.jobGuid)
      if (job) matches.push({ ...site, job })
    } catch (e) {
      failures.push(e instanceof Error ? e.message : String(e))
    }
  })

  if (matches.length === 0 && sites.length > 0 && failures.length === sites.length) {
    throw new Error(failures[0])
  }
  return matches
}

export function toJobDetail(match: SiteMatch): JobDetail | null {
  const parsed = parseJob(match.job, match.siteGuid, match.company ?? "")
  if (!parsed) return null
  return {
    ...parsed.result,
    description: parsed.description,
    employmentType: parsed.employmentType,
    department: parsed.department,
    published: parsed.published,
    endDate: parsed.endDate,
    refNo: parsed.refNo,
  }
}

export async function runDetail(opts: DetailOpts, deps: DetailDeps = defaultDetailDeps()): Promise<number> {
  const target = normalizeTarget(opts.id)
  if (!target) {
    writeError(
      `Could not parse a Visma Talent target from "${opts.id}". Use "<siteGuid>:<jobGuid>", a bare job GUID, or a URL containing guidAssignment.`,
      "BAD_ID",
    )
    return 1
  }

  try {
    const matches = await findJob(target, deps.employers, deps.fetchText)
    if (matches.length === 0) {
      writeError("Job not found", "NOT_FOUND")
      return 1
    }
    if (matches.length > 1) {
      writeError(
        `Job GUID ${target.jobGuid} is present on ${matches.length} career sites; pass "<siteGuid>:<jobGuid>" to disambiguate`,
        "AMBIGUOUS_ID",
      )
      return 1
    }

    const job = stripInvisible(toJobDetail(matches[0]))
    if (!job) {
      writeError("Job not found", "NOT_FOUND")
      return 1
    }

    if (opts.format === "plain") {
      const lines = [
        job.title,
        `${job.company || "—"} · ${job.location || "—"}`,
        job.employmentType ? `Employment: ${job.employmentType}` : "",
        job.published ? `Published: ${job.published}` : "",
        job.endDate ? `End date: ${job.endDate}` : "",
        job.department ? `Department: ${job.department}` : "",
        job.refNo ? `Reference: ${job.refNo}` : "",
        `URL: ${job.url}`,
        "",
        job.description || "(no description)",
      ].filter((line) => line !== "")
      process.stdout.write(lines.join("\n") + "\n")
    } else {
      process.stdout.write(JSON.stringify(job, null, 2) + "\n")
    }
    return 0
  } catch (e) {
    if (e instanceof MissingRegistryError) {
      writeError(e.message, "NO_REGISTRY")
    } else {
      writeError(e instanceof Error ? e.message : String(e), "DETAIL_FAILED")
    }
    return 1
  }
}
