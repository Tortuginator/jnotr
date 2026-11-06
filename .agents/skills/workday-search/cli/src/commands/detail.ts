import {
  cleanInline,
  companyForDetail,
  fetchDetailInfo,
  htmlToText,
  loadRegistry,
  parsePostedOn,
  resolveTarget,
  stripInvisible,
  writeError,
} from "../helpers.js"

export interface DetailOpts {
  input: string
  format: "json" | "plain"
}

function countryName(country: { descriptor?: string | null } | string | null | undefined): string | null {
  if (!country) return null
  if (typeof country === "string") return cleanInline(country)
  return cleanInline(country.descriptor)
}

export async function runDetail(opts: DetailOpts): Promise<number> {
  const registry = loadRegistry()
  const target = resolveTarget(opts.input, registry)
  if ("error" in target) {
    writeError(target.error, target.code)
    return 1
  }

  try {
    const info = await fetchDetailInfo(target.site, target.externalPath)
    if (!info) {
      writeError("Job posting not found (404 or empty response)", "NOT_FOUND")
      return 1
    }

    const title = cleanInline(info.title)
    const description = htmlToText(info.jobDescription)
    if (!title && !description) {
      writeError("Job posting not found (response contained no posting data)", "NOT_FOUND")
      return 1
    }

    const startDate = typeof info.startDate === "string" ? info.startDate.slice(0, 10) : null
    const postedOn = typeof info.postedOn === "string" ? info.postedOn : null
    const date = startDate ?? parsePostedOn(postedOn)
    const additionalLocations = Array.isArray(info.additionalLocations)
      ? info.additionalLocations.map((value) => cleanInline(value)).filter((value): value is string => Boolean(value))
      : []

    const detail = {
      id: `${target.site.tenant}/${target.site.site}${target.externalPath}`,
      title,
      company: companyForDetail(info, target.site, registry),
      location: cleanInline(info.location),
      additionalLocations,
      date,
      postedOn,
      startDate,
      endDate: typeof info.endDate === "string" ? info.endDate.slice(0, 10) : null,
      timeType: cleanInline(info.timeType),
      jobReqId: cleanInline(info.jobReqId),
      country: countryName(info.country),
      url: cleanInline(info.externalUrl) ?? target.publicUrl,
      description,
    }

    const clean = stripInvisible(detail)

    if (opts.format === "plain") {
      const locations = [clean.location, ...clean.additionalLocations].filter(Boolean).join("; ")
      const lines: Array<string | null> = [
        clean.title || "(untitled)",
        `${clean.company || "—"} · ${locations || "—"}`,
        "",
        clean.date ? `Date: ${clean.date}` : null,
        clean.postedOn ? `Posted: ${clean.postedOn}` : null,
        clean.startDate ? `Start: ${clean.startDate}` : null,
        clean.endDate ? `End: ${clean.endDate}` : null,
        clean.timeType ? `Time type: ${clean.timeType}` : null,
        clean.jobReqId ? `Requisition: ${clean.jobReqId}` : null,
        clean.country ? `Country: ${clean.country}` : null,
        "",
        clean.description || "(no description)",
        "",
        `URL: ${clean.url}`,
      ]
      process.stdout.write(lines.filter((line): line is string => line !== null).join("\n") + "\n")
    } else {
      process.stdout.write(JSON.stringify(clean, null, 2) + "\n")
    }
    return 0
  } catch (error) {
    writeError(error instanceof Error ? error.message : String(error), "DETAIL_FAILED")
    return 1
  }
}
