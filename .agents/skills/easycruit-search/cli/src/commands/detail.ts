import {
  canonicalVacancyUrl,
  combineLocation,
  detailHtmlUrl,
  detailXmlUrl,
  employerLocationHint,
  fetchHtml,
  fetchXml,
  htmlToTextDecoded,
  loadArea,
  loadRegistry,
  normalizeDate,
  normalizeDetailInput,
  parseDetailHtml,
  parseVacancyXml,
  stripInvisible,
  writeError,
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function runDetail(opts: DetailOpts, deps: DetailDeps = {}): Promise<number> {
  const parsed = normalizeDetailInput(opts.id)
  if (!parsed) {
    writeError(`Could not parse an EasyCruit vacancy id or URL from "${opts.id}"`, "BAD_ID")
    return 1
  }
  if ("code" in parsed) {
    writeError(parsed.message, parsed.code)
    return 1
  }

  const fetchImpl = deps.fetchImpl ?? fetch
  const slug = parsed.slug
  const vacancyId = parsed.id
  if (!slug) {
    writeError("Could not resolve an EasyCruit employer slug", "BAD_ID")
    return 1
  }

  const baseUrl = `https://${slug}.easycruit.com`

  // The HTML page has div.jd-location and the readable description; the XML
  // detail has date_start (the HTML page exposes no publication date). Fetch
  // both so either endpoint can carry the result if the other is unavailable.
  const [htmlResult, xmlResult] = await Promise.allSettled([
    fetchHtml(detailHtmlUrl(baseUrl, vacancyId), fetchImpl),
    fetchXml(detailXmlUrl(baseUrl, vacancyId), fetchImpl),
  ])

  const html = htmlResult.status === "fulfilled" ? htmlResult.value : ""
  const xml = xmlResult.status === "fulfilled" ? xmlResult.value : ""
  const htmlError = htmlResult.status === "rejected" ? htmlResult.reason : null
  const xmlError = xmlResult.status === "rejected" ? xmlResult.reason : null

  if (!html && !xml) {
    const messages = [htmlError, xmlError].filter(Boolean).map(errorMessage)
    const blocked = messages.find((message) => /WAF challenge|HTTP 202/i.test(message))
    if (blocked) {
      writeError(blocked, "BLOCKED")
    } else if (messages.length > 0) {
      writeError(messages.join("; "), "DETAIL_FAILED")
    } else {
      writeError("Job posting not found (404 or empty response)", "NOT_FOUND")
    }
    return 1
  }

  const htmlDetail = html ? parseDetailHtml(html, canonicalVacancyUrl(slug, vacancyId)) : null
  const xmlDetail = xml ? parseVacancyXml(xml) : null
  const registry = loadRegistry()
  const employer = registry?.employers.find((entry) => entry.slug === slug) ?? null
  const area = loadArea()
  const hint = employer ? employerLocationHint(employer.name, area) : null

  const title =
    htmlDetail?.title ??
    xmlDetail?.title ??
    xmlDetail?.titleHeading ??
    null
  const company = employer?.name ?? xmlDetail?.alternativeCompanyName ?? null
  const location = combineLocation(htmlDetail?.location ?? xmlDetail?.location, hint, employer?.name ?? null)
  const date = normalizeDate(xmlDetail?.dateStart)
  const url = xmlDetail?.vacancyUrl ?? canonicalVacancyUrl(slug, vacancyId)
  const description = htmlDetail?.description ?? htmlToTextDecoded(xmlDetail?.descriptionHtml)
  const employmentType = xmlDetail && xmlDetail.categories.length > 0 ? xmlDetail.categories.join(", ") : null

  const job = stripInvisible({
    id: `${slug}/${vacancyId}`,
    title,
    company,
    location,
    date,
    url,
    description,
    deadline: htmlDetail?.deadline ?? xmlDetail?.deadline ?? null,
    employmentType,
    worktime: htmlDetail?.worktime ?? null,
    region: htmlDetail?.region ?? xmlDetail?.region ?? null,
    referenceNumber: xmlDetail?.referenceNumber ?? null,
  } as JobDetail)

  if (opts.format === "plain") {
    const lines = [
      job.title || "(untitled)",
      `${job.company || "—"} · ${job.location || "—"} · ${job.date || "—"}`,
      job.deadline ? `Deadline: ${job.deadline}` : "",
      job.employmentType ? `Employment: ${job.employmentType}` : "",
      job.worktime ? `Working time: ${job.worktime}` : "",
      job.region ? `Region: ${job.region}` : "",
      job.referenceNumber ? `Reference: ${job.referenceNumber}` : "",
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
}
