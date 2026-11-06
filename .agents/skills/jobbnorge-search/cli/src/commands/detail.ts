import {
  ID_API_BASE,
  jsonFetch,
  loadEmployerIndex,
  parseJobDetail,
  stripInvisible,
  writeError,
  type JobContent,
  type JobDetail,
  type JobInfo,
} from "../helpers.js"

export interface DetailOpts {
  id: string
  format: "json" | "plain"
}

const JOBBNORGE_HOST = /(^|\.)jobbnorge\.no$/i

/**
 * Accept a numeric job id or a Jobbnorge posting URL. Non-Jobbnorge URLs are
 * rejected: a detail command that silently read the first number out of an
 * unrelated URL would print a different posting than the caller supplied.
 */
export function normalizeId(input: string): string | null {
  const trimmed = input.trim()
  if (/^\d{1,9}$/.test(trimmed)) return trimmed

  const hasScheme = /^https?:\/\//i.test(trimmed)
  if (hasScheme || /^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(trimmed)) {
    let parsed: URL
    try {
      parsed = new URL(hasScheme ? trimmed : `https://${trimmed}`)
    } catch {
      return null
    }
    if (!JOBBNORGE_HOST.test(parsed.hostname)) return null

    const match =
      parsed.pathname.match(/\/ledige-stillinger\/stilling\/(\d+)(?:\/|$)/) ??
      parsed.pathname.match(/\/stilling\/(\d+)(?:\/|$)/)
    return match ? match[1] : null
  }

  return null
}

/** Try Jobbnorge's content languages in order; a job may exist in only one. */
async function fetchContent(id: string): Promise<{ content: JobContent; language: number } | null> {
  for (const language of [1, 2, 3, 4]) {
    const content = await jsonFetch<JobContent>(
      `${ID_API_BASE}/joblisting?jobId=${encodeURIComponent(id)}&languageId=${language}`,
    )
    if (content) return { content, language }
  }
  return null
}

function renderPlain(job: JobDetail): string {
  const lines: string[] = [job.title, `${job.company || "\u2014"} \u00b7 ${job.location || "\u2014"}`]

  if (job.deadline) lines.push(`Deadline: ${job.deadline}`)
  if (job.employmentType) lines.push(`Employment: ${job.employmentType}`)
  if (job.positionCount !== null) lines.push(`Positions: ${job.positionCount}`)
  for (const contact of job.contacts) {
    const details = [contact.title, contact.email, contact.phone].filter(Boolean).join(" \u00b7 ")
    lines.push(`Contact: ${contact.name || "\u2014"}${details ? ` (${details})` : ""}`)
  }
  lines.push(`Status: ${job.isActive === null ? "UNKNOWN" : job.isActive ? "PUBLISHED" : "NOT PUBLISHED"}`)
  if (job.language) lines.push(`Language: ${job.language}`)
  lines.push("", job.description || "(no description)", "", `URL: ${job.url}`)

  return lines.join("\n")
}

export async function runDetail(opts: DetailOpts): Promise<number> {
  const id = normalizeId(opts.id)
  if (!id) {
    writeError(`Could not parse a Jobbnorge job id from "${opts.id}"`, "BAD_ID")
    return 1
  }

  try {
    // job-info is language-independent for this purpose and still answers for
    // jobs whose content is only available in one language.
    const info = await jsonFetch<JobInfo>(
      `${ID_API_BASE}/joblisting/job-info?jobId=${encodeURIComponent(id)}&languageId=1`,
    )
    const fetched = await fetchContent(id)
    if (!fetched) {
      writeError("Job not found", "NOT_FOUND")
      return 1
    }

    const employers = loadEmployerIndex()
    const job = stripInvisible(parseJobDetail(id, info, fetched.content, employers, fetched.language))

    if (opts.format === "plain") {
      process.stdout.write(renderPlain(job) + "\n")
    } else {
      process.stdout.write(JSON.stringify(job, null, 2) + "\n")
    }
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "DETAIL_FAILED")
    return 1
  }
}
