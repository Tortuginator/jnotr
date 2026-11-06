import {
  fetchPosting,
  loadRegistry,
  parseDetail,
  stripInvisible,
  writeError,
} from "../helpers.js"

export interface DetailOpts {
  input: string
  format: "json" | "plain"
}

function isSafeHttpUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false
  const host = url.hostname.toLowerCase()
  if (!host || host === "localhost" || host.endsWith(".localhost")) return false
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.startsWith("[")) return false
  return true
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value) || /^[a-z0-9.-]+\.[a-z]{2,}\//i.test(value)
}

function asUrl(value: string): string | null {
  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`
  return isSafeHttpUrl(candidate) ? candidate : null
}

/**
 * Accept a full posting URL or a bare id. A bare id can only be turned into a
 * URL when the registry has exactly one Teamtailor employer; otherwise tell the
 * caller to pass the posting URL (the search result's `url`).
 */
function resolveTarget(input: string): { url: string } | { error: string; code: string } {
  const trimmed = input.trim()
  if (!trimmed) return { error: "detail requires an <id|url>", code: "NO_ID" }

  if (looksLikeUrl(trimmed)) {
    const url = asUrl(trimmed)
    if (!url) return { error: `Not a usable http(s) posting URL: "${trimmed}"`, code: "BAD_URL" }
    return { url }
  }

  const registry = loadRegistry()
  if (!registry) {
    return {
      error: "A bare id cannot be resolved without the employer registry. Pass the full posting URL instead.",
      code: "NO_REGISTRY",
    }
  }
  if (registry.employers.length !== 1) {
    return {
      error: `A bare id is ambiguous with ${registry.employers.length} Teamtailor employers. Pass the full posting URL instead (search returns it as "url").`,
      code: "AMBIGUOUS_ID",
    }
  }
  const origin = new URL(registry.employers[0].feedUrl).origin
  return { url: `${origin}/jobs/${encodeURIComponent(trimmed)}` }
}

export async function runDetail(opts: DetailOpts): Promise<number> {
  const target = resolveTarget(opts.input)
  if ("error" in target) {
    writeError(target.error, target.code)
    return 1
  }

  try {
    const html = await fetchPosting(target.url)
    if (!html) {
      writeError("Job posting not found (404 or empty response)", "NOT_FOUND")
      return 1
    }

    const detail = stripInvisible(parseDetail(html, target.url))
    if (!detail.title && !detail.description) {
      writeError("Job posting not found (page contained no posting data)", "NOT_FOUND")
      return 1
    }

    if (opts.format === "plain") {
      const lines = [
        detail.title || "(untitled)",
        `${detail.company || "—"} · ${detail.location || "—"} · ${detail.date || "—"}`,
        "",
        detail.description || "(no description)",
        "",
        `URL: ${detail.url}`,
      ]
      process.stdout.write(lines.join("\n") + "\n")
    } else {
      process.stdout.write(JSON.stringify(detail, null, 2) + "\n")
    }
    return 0
  } catch (error) {
    writeError(error instanceof Error ? error.message : String(error), "DETAIL_FAILED")
    return 1
  }
}
