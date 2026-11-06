import {
  fetchText,
  htmlToText,
  stripInvisible,
  toIsoDate,
  writeError,
  type FetchInit,
} from "../helpers.js"

export interface DetailOpts {
  id: string
  format: "json" | "plain"
}

export interface DetailTarget {
  url: string
  id: string
  tenant: string
  advertId: string
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
  employmentType: string | null
}

/**
 * Accept `tenant:advertId` (the search-result id) or a Webcruiter posting
 * URL. A bare advert id is rejected: the public URL needs a tenant host, and
 * guessing one can fetch another employer's advert with the same number.
 */
export function normalizeTarget(input: string): DetailTarget | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  const tenantId = trimmed.match(/^(\d+):(\d+)$/)
  if (tenantId) {
    return {
      tenant: tenantId[1],
      advertId: tenantId[2],
      id: `${tenantId[1]}:${tenantId[2]}`,
      url: `https://${tenantId[1]}.webcruiter.no/Main/Recruit/Public/${tenantId[2]}`,
    }
  }

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  let parsed: URL
  try {
    parsed = new URL(withScheme)
  } catch {
    return null
  }

  const tenantHost = parsed.hostname.match(/^(\d+)\.webcruiter\.no$/i)
  if (!tenantHost) return null
  const advert = parsed.pathname.match(/\/(?:Main2?\/)?Recruit\/Public\/(\d+)/i)
  if (!advert) return null

  return {
    tenant: tenantHost[1],
    advertId: advert[1],
    id: `${tenantHost[1]}:${advert[1]}`,
    url: parsed.toString(),
  }
}

function extractAllDivContents(html: string, className: string): string[] {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const openRe = new RegExp(`<div[^>]*class="[^"]*${escaped}[^"]*"[^>]*>`, "i")
  const blocks: string[] = []
  let searchFrom = 0

  while (searchFrom < html.length) {
    const slice = html.slice(searchFrom)
    const open = openRe.exec(slice)
    if (!open) break
    const startContent = searchFrom + open.index + open[0].length
    let i = startContent
    let depth = 1
    while (depth > 0 && i < html.length) {
      const nextOpen = html.indexOf("<div", i)
      const nextClose = html.indexOf("</div>", i)
      if (nextClose === -1) break
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth++
        i = nextOpen + 4
      } else {
        depth--
        i = nextClose + 6
      }
    }
    if (depth !== 0) break
    blocks.push(html.slice(startContent, i - 6))
    searchFrom = i
  }

  return blocks
}

function firstMatch(html: string, re: RegExp): string | null {
  const match = re.exec(html)
  return match ? htmlToText(match[1]) || null : null
}

interface InfoRow {
  label: string
  value: string
}

function parseInfoRows(html: string): InfoRow[] {
  const rows: InfoRow[] = []
  const re =
    /key-info-header[^>]*>[\s\S]*?<span>([^<]+)<\/span>[\s\S]*?key-info-value[^>]*>([\s\S]*?)<\/div>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const label = htmlToText(m[1]).replace(/:\s*$/, "").trim()
    const value = htmlToText(m[2])
    if (label && value) rows.push({ label, value })
  }
  return rows
}

function infoValue(rows: InfoRow[], labels: string[]): string | null {
  const wanted = labels.map((label) => label.toLowerCase())
  for (const row of rows) {
    if (wanted.includes(row.label.toLowerCase())) return row.value
  }
  return null
}

export function parseWebcruiterDetail(html: string, target: DetailTarget): JobDetail {
  const title =
    firstMatch(html, /<h1[^>]*>[\s\S]*?<span[^>]*class="[^"]*we-editable[^"]*"[^>]*>([\s\S]*?)<\/span>/i) ??
    firstMatch(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i) ??
    "(untitled)"

  const subtitle = firstMatch(html, /<h1[^>]*>[\s\S]*?<small[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i)

  const rows = parseInfoRows(html)
  const company = infoValue(rows, ["Arbeidsgiver", "Employer"]) ?? subtitle
  const location = infoValue(rows, ["Sted", "Location", "Arbeidssted"])
  const deadline = infoValue(rows, ["Søknadsfrist", "Application deadline"])
  const published = infoValue(rows, ["Publisert", "Publiseringsdato", "Published"])
  const employmentType = infoValue(rows, ["Ansettelsesform", "Employment type", "Stillingsstørrelse"])

  const descriptionBlocks = extractAllDivContents(html, "we-bullets")
  const description =
    descriptionBlocks.length > 0
      ? descriptionBlocks.map((block) => htmlToText(block)).filter(Boolean).join("\n\n") || null
      : null

  return {
    id: target.id,
    title,
    company,
    location,
    date: published ? toIsoDate(published) : null,
    url: target.url,
    description,
    deadline,
    employmentType,
  }
}

export async function runDetail(
  opts: DetailOpts,
  fetcher: (url: string, init?: FetchInit) => Promise<string | null> = fetchText,
): Promise<number> {
  const target = normalizeTarget(opts.id)
  if (!target) {
    writeError(
      `Could not parse a Webcruiter target from "${opts.id}". Use a posting URL or "tenant:advertId" (e.g. 7254:5198357738).`,
      "BAD_ID",
    )
    return 1
  }

  try {
    const html = await fetcher(target.url)
    if (!html) {
      writeError("Job not found", "NOT_FOUND")
      return 1
    }
    const job = stripInvisible(parseWebcruiterDetail(html, target))

    if (opts.format === "plain") {
      const lines = [
        job.title,
        `${job.company || "—"} · ${job.location || "—"}`,
        job.date ? `Published: ${job.date}` : "",
        job.deadline ? `Deadline: ${job.deadline}` : "",
        job.employmentType ? `Employment: ${job.employmentType}` : "",
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
    writeError(e instanceof Error ? e.message : String(e), "DETAIL_FAILED")
    return 1
  }
}
