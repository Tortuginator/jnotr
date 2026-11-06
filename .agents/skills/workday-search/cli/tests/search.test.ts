import { describe, expect, test } from "bun:test"
import { normalizeRegistry, parseCsv } from "../src/helpers"
import { FIXTURES, fixtureEnv, parseJSON, runCLI } from "./helpers"

interface SearchResult {
  id: string | null
  title: string | null
  company: string | null
  location: string | null
  date: string | null
  url: string | null
}

interface SearchResponse {
  meta: { count: number; page: number; errors: { employer: string; error: string }[] }
  results: SearchResult[]
}

async function search(args: string[], env = fixtureEnv()): Promise<SearchResponse> {
  return parseJSON<SearchResponse>(await runCLI(["search", ...args], env))
}

describe("registry", () => {
  test("keeps enabled Workday rows and reports missing ats_ref", () => {
    const text = parseCsv(
      [
        "orgnr,name,ats,ats_ref,enabled",
        '1,Equinor AS,workday,https://equinor.wd3.myworkdayjobs.com/EQNR,true',
        '2,Norconsult AS,workday,https://norconsult.wd3.myworkdayjobs.com/Norconsult_Career_Site,true',
        "3,No Ref AS,workday,,true",
        "4,Disabled AS,workday,https://disabled.wd3.myworkdayjobs.com/Site,false",
        "5,Teamtailor AS,teamtailor,https://x.teamtailor.com/jobs.rss,true",
      ].join("\n"),
    )
    expect(text).toHaveLength(6)

    const registry = normalizeRegistry(
      [
        "orgnr,name,ats,ats_ref,enabled",
        '1,Equinor AS,workday,https://equinor.wd3.myworkdayjobs.com/EQNR,true',
        '2,Norconsult AS,workday,https://norconsult.wd3.myworkdayjobs.com/Norconsult_Career_Site,true',
        "3,No Ref AS,workday,,true",
        "4,Disabled AS,workday,https://disabled.wd3.myworkdayjobs.com/Site,false",
        "5,Teamtailor AS,teamtailor,https://x.teamtailor.com/jobs.rss,true",
      ].join("\n"),
    )
    expect(registry.employers.map((employer) => employer.name)).toEqual(["Equinor AS", "Norconsult AS"])
    expect(registry.employers[0].site.site).toBe("EQNR")
    expect(registry.errors).toEqual([{ employer: "No Ref AS", error: "missing ats_ref; employer skipped" }])
  })

  test("reports an invalid Workday ref", () => {
    const registry = normalizeRegistry(
      ["name,ats,ats_ref,enabled", "Bad AS,workday,https://example.com/careers,true"].join("\n"),
    )
    expect(registry.employers).toHaveLength(0)
    expect(registry.errors[0].error).toContain("invalid ats_ref")
  })
})

describe("search: pooled Workday results", () => {
  test("pools Trondheim-area jobs from several employers", async () => {
    const data = await search(["-l", "area", "--format", "json"])

    expect(data.meta.page).toBe(1)
    expect(data.meta.count).toBe(data.results.length)
    expect(data.results.every((result) => result.id && result.title && result.url)).toBe(true)

    expect(data.results.some((result) => result.company === "EQUINOR ASA")).toBe(true)
    expect(data.results.some((result) => result.company === "NORCONSULT NORGE AS")).toBe(true)
    expect(data.results.some((result) => result.company === "ASKO MIDT-NORGE AS")).toBe(true)
    expect(data.results.some((result) => result.company === "NG MENY MIDT-NORGE AS")).toBe(true)
    expect(data.results.some((result) => result.company === "IF SKADEFORSIKRING NUF")).toBe(true)

    // Multi-location postings only enter after their detail confirms the area.
    expect(data.results.some((result) => result.title === "Data Scientist - Agentic AI")).toBe(true)
    expect(data.results.some((result) => result.title === "Claims Handler")).toBe(true)
    expect(data.results.some((result) => result.title === "Network Security Engineer")).toBe(false)
    expect(data.results.some((result) => result.title === "Principal Agentic AI Expert")).toBe(false)
    expect(data.results.some((result) => result.title === "Rådgiver samferdsel")).toBe(false)
  })

  test("keeps every contract field, using null rather than omission", async () => {
    const data = await search(["--format", "json"])
    const result = data.results.find((entry) => entry.title === "Role Without Metadata")

    expect(result).toBeDefined()
    expect(Object.keys(result!).sort()).toEqual(["company", "date", "id", "location", "title", "url"])
    expect(result!.date).toBeNull()
    expect(result!.location).toBeNull()
  })

  test("filters by job age using the relative postedOn label", async () => {
    const data = await search(["--jobage", "1", "--format", "json"])

    expect(data.results.some((result) => result.title === "Principal Agentic AI Expert")).toBe(true)
    expect(data.results.some((result) => result.title === "Data Scientist - Agentic AI")).toBe(false)
    expect(data.results.some((result) => result.title === "Sommerjobb 2027 – Dam og vassdrag")).toBe(false)
  })

  test("filters by a specific place and expands its municipality", async () => {
    const data = await search(["-l", "Heimdal", "--format", "json"])

    // NorgesGruppen's site has no facet-filtered fixture for Heimdal, so the
    // unfiltered list is matched client-side on locationsText.
    expect(data.results.some((result) => result.title === "Joker Heimdal søker butikkmedarbeider")).toBe(true)
    expect(data.results.some((result) => result.title === "MENY Solsiden søker butikkmedarbeider")).toBe(true)
    expect(data.results.find((result) => result.title === "Joker Heimdal søker butikkmedarbeider")?.company).toBe(
      "Joker",
    )
    expect(data.results.some((result) => result.title === "Data Scientist - Agentic AI")).toBe(false)
  })

  test("reports skipped registry rows in meta.errors", async () => {
    const data = await search(["-l", "area", "--format", "json"])
    expect(data.meta.errors).toContainEqual({
      employer: "NO REF AS",
      error: "missing ats_ref; employer skipped",
    })
  })

  test("records a failing site without failing the run", async () => {
    const data = await search(["--format", "json"], fixtureEnv(FIXTURES, "employers-fail.csv"))
    expect(data.results).toHaveLength(0)
    expect(data.meta.errors.some((error) => error.employer === "FAILING AS")).toBe(true)
  })

  test("respects --limit and --page", async () => {
    const limited = await search(["--limit", "2", "--format", "json"])
    expect(limited.results).toHaveLength(2)
    expect(limited.meta.count).toBe(2)

    const page2 = await search(["--page", "2", "--limit", "2", "--format", "json"])
    expect(page2.meta.page).toBe(2)
    expect(page2.meta.count).toBe(page2.results.length)
  })
})

describe("CLI contract", () => {
  test("rejects an unknown flag with a JSON error on stderr", async () => {
    const result = await runCLI(["search", "--bogus"], fixtureEnv())
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stderr).code).toBe("UNKNOWN_FLAG")
    expect(result.stdout).toBe("")
  })

  test("rejects an unknown detail flag", async () => {
    const result = await runCLI(["detail", "x", "--bogus"], fixtureEnv())
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stderr).code).toBe("UNKNOWN_FLAG")
  })

  test("errors with NO_REGISTRY when no registry exists", async () => {
    const result = await runCLI(["search"], {
      WORKDAY_REGISTRY: "/nonexistent/employers.csv",
      WORKDAY_FIXTURE_DIR: FIXTURES,
    })
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stderr).code).toBe("NO_REGISTRY")
  })

  test("rejects an invalid --format", async () => {
    const result = await runCLI(["search", "--format", "xml"], fixtureEnv())
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stderr).code).toBe("BAD_ARG")
  })
})
