import {
  DEFAULT_FEED_BASE,
  HttpError,
  asRecord,
  cleanText,
  htmlToText,
  isoDate,
  isoDateTime,
  jsonFetch,
  loadEmployers,
  normalizeCompany,
  parseUuid,
  publicAdUrl,
  readCacheFile,
  resolvePaths,
  str,
  stripInvisible,
  writeError,
  type EmployerRow,
  type NormRecord,
} from "../helpers.js"

export interface DetailOpts {
  id: string
  format: "json" | "plain"
}

export interface DetailRecord extends NormRecord {
  sector: string | null
  updated: string | null
  application_url: string | null
}

function emptyDetail(uuid: string, status: string, fallback?: NormRecord): DetailRecord {
  return {
    id: uuid,
    uuid,
    title: fallback?.title ?? null,
    company: fallback?.company ?? null,
    raw_company: fallback?.raw_company ?? null,
    location: fallback?.location ?? null,
    municipal: fallback?.municipal ?? null,
    city: fallback?.city ?? null,
    postal_code: fallback?.postal_code ?? null,
    date: fallback?.date ?? null,
    date_modified: fallback?.date_modified ?? null,
    published: fallback?.published ?? null,
    expires: fallback?.expires ?? null,
    deadline: fallback?.deadline ?? null,
    status,
    description: fallback?.description ?? null,
    content_text: fallback?.content_text ?? null,
    url: fallback?.url ?? publicAdUrl(uuid),
    orgnr: fallback?.orgnr ?? null,
    employment_type: fallback?.employment_type ?? null,
    extent: fallback?.extent ?? null,
    sector: null,
    updated: null,
    application_url: null,
  }
}

export function normalizeDetail(
  raw: unknown,
  uuid: string,
  employers: EmployerRow[],
  fallback?: NormRecord,
): DetailRecord {
  const root = asRecord(raw)
  if (!root) return emptyDetail(uuid, fallback?.status ?? "UNKNOWN", fallback)

  const status = (str(root.status) ?? fallback?.status ?? "UNKNOWN").toUpperCase()
  const ad = asRecord(root.ad_content)
  if (!ad) {
    const empty = emptyDetail(uuid, status, fallback)
    const lastChange = isoDateTime(str(root.sistEndret))
    return {
      ...empty,
      date_modified: lastChange ?? empty.date_modified,
      date: empty.date ?? isoDate(lastChange),
    }
  }

  const location = Array.isArray(ad.workLocations)
    ? asRecord(ad.workLocations[0]) ?? null
    : null
  const employer = asRecord(ad.employer)

  const rawCompany = str(employer?.name) ?? fallback?.raw_company ?? null
  const orgnr = str(employer?.orgnr) ?? fallback?.orgnr ?? null
  const published = isoDateTime(str(ad.published))
  const updated = isoDateTime(str(ad.updated))
  const expires = isoDateTime(str(ad.expires))
  const municipal = str(location?.municipal) ?? fallback?.municipal ?? null
  const city = str(location?.city) ?? fallback?.city ?? null
  const dateModified = isoDateTime(str(root.sistEndret)) ?? fallback?.date_modified ?? null

  return {
    id: uuid,
    uuid,
    title: cleanText(str(ad.title)) ?? fallback?.title ?? null,
    company: normalizeCompany(rawCompany, orgnr, employers) ?? fallback?.company ?? null,
    raw_company: rawCompany,
    location: cleanText(city) ?? cleanText(municipal) ?? fallback?.location ?? null,
    municipal,
    city,
    postal_code: str(location?.postalCode) ?? fallback?.postal_code ?? null,
    date: isoDate(published) ?? isoDate(updated) ?? isoDate(dateModified) ?? fallback?.date ?? null,
    date_modified: dateModified,
    published,
    expires,
    deadline: isoDate(str(ad.applicationDue)) ?? isoDate(expires) ?? fallback?.deadline ?? null,
    status,
    description: htmlToText(str(ad.description)) ?? fallback?.description ?? null,
    content_text: fallback?.content_text ?? null,
    url: str(ad.link) || fallback?.url || publicAdUrl(uuid),
    orgnr,
    employment_type: cleanText(str(ad.engagementtype)) ?? fallback?.employment_type ?? null,
    extent: cleanText(str(ad.extent)) ?? fallback?.extent ?? null,
    sector: cleanText(str(ad.sector)),
    updated,
    application_url: str(ad.applicationUrl),
  }
}

export async function runDetail(opts: DetailOpts): Promise<number> {
  const id = parseUuid(opts.id)
  if (!id) {
    writeError(`Could not parse a NAV feed entry id from "${opts.id}"`, "BAD_ID")
    return 1
  }

  const token = process.env.NAV_API_TOKEN?.trim()
  if (!token) {
    writeError(
      "NAV_API_TOKEN is not set. Request a private token from NAV (nav.team.arbeidsplassen@nav.no) and export NAV_API_TOKEN before fetching details.",
      "MISSING_CREDENTIALS",
    )
    return 1
  }

  const paths = resolvePaths()
  const base = (process.env.NAV_FEED_BASE_URL || DEFAULT_FEED_BASE).replace(/\/+$/, "")
  try {
    const raw = await jsonFetch<unknown>(`${base}/api/v1/feedentry/${id}`, { token })
    if (!raw) {
      writeError("Job ad not found in the NAV feed", "NOT_FOUND")
      return 1
    }
    const fallback = readCacheFile(paths.cachePath).get(id)
    const detail = stripInvisible(normalizeDetail(raw, id, loadEmployers(paths.employersPath), fallback))

    if (opts.format === "plain") {
      const meta = [
        detail.title ?? "(untitled)",
        `${detail.company ?? "—"} · ${detail.location ?? "—"}`,
        detail.date ? `Published: ${detail.date}` : "",
        detail.deadline ? `Deadline: ${detail.deadline}` : "",
        detail.employment_type || detail.extent
          ? `Employment: ${[detail.employment_type, detail.extent].filter(Boolean).join(" · ")}`
          : "",
        detail.status ? `Status: ${detail.status}` : "",
      ].filter(Boolean)
      const description =
        detail.description ??
        (detail.status === "INACTIVE"
          ? "(the ad is no longer active; NAV no longer returns its description)"
          : "(no description)")
      process.stdout.write([meta.join("\n"), description, `URL: ${detail.url}`].join("\n\n") + "\n")
    } else {
      process.stdout.write(JSON.stringify(detail, null, 2) + "\n")
    }
    return 0
  } catch (error) {
    if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
      writeError("NAV rejected the bearer token (401/403). Check NAV_API_TOKEN.", "AUTH_FAILED")
    } else {
      writeError(error instanceof Error ? error.message : String(error), "DETAIL_FAILED")
    }
    return 1
  }
}
