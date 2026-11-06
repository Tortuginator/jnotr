import {
  companyForTarget,
  fetchText,
  loadRegistry,
  normalizeDetailTarget,
  parseAttractDetail,
  parseExtDetail,
  stripInvisible,
  writeError,
  type Employer,
  type FetchInit,
  type JobDetail,
} from "../helpers.js"

export interface DetailOpts {
  id: string
  format: "json" | "plain"
}

export interface DetailDeps {
  fetchText: (url: string, init?: FetchInit) => Promise<string | null>
  employers: Employer[]
}

export const defaultDetailDeps = (): DetailDeps => ({
  fetchText,
  employers: loadRegistry(),
})

export async function runDetail(opts: DetailOpts, deps: DetailDeps = defaultDetailDeps()): Promise<number> {
  const target = normalizeDetailTarget(opts.id)
  if (!target) {
    writeError(
      `Could not parse a ReachMee posting URL from "${opts.id}". Search results use the full posting URL as their id, so pass that URL here.`,
      "BAD_ID",
    )
    return 1
  }

  try {
    const html = await deps.fetchText(target.url)
    if (!html) {
      writeError("Job not found", "NOT_FOUND")
      return 1
    }

    const company = companyForTarget(target, deps.employers)
    const job: JobDetail =
      target.kind === "attract"
        ? parseAttractDetail(html, target, company)
        : parseExtDetail(html, target, company)

    const clean = stripInvisible(job)
    if (opts.format === "plain") {
      const lines = [
        clean.title,
        `${clean.company || "—"} · ${clean.location || "—"}`,
        clean.department ? `Department: ${clean.department}` : "",
        clean.deadline ? `Deadline: ${clean.deadline}` : "",
        `URL: ${clean.url}`,
        "",
        clean.description || "(no description)",
      ].filter((line) => line !== "")
      process.stdout.write(lines.join("\n") + "\n")
    } else {
      process.stdout.write(JSON.stringify(clean, null, 2) + "\n")
    }
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "DETAIL_FAILED")
    return 1
  }
}
