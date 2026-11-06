import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isWithinDays } from "../src/helpers"
import { FIXTURES, fixtureEnv, parseJSON, runCLI } from "./helpers"

interface SearchResponse {
  meta: { count: number; page: number; errors: { employer: string; error: string }[] }
  results: {
    id: string | null
    title: string | null
    company: string | null
    location: string | null
    date: string | null
    url: string | null
  }[]
}

async function search(args: string[], env = fixtureEnv()): Promise<SearchResponse> {
  return parseJSON<SearchResponse>(await runCLI(["search", ...args], env))
}

describe("search: area and employers", () => {
  test("pools Trondheim-area jobs from more than one employer", async () => {
    const data = await search(["-l", "area", "--format", "json"])

    expect(data.meta.page).toBe(1)
    expect(data.meta.count).toBe(data.results.length)
    expect(data.results.some((r) => r.company === "Alpha AS" && r.title === "Senior Engineer")).toBe(true)
    expect(data.results.some((r) => r.company === "Beta AS" && r.title === "Beta Developer")).toBe(true)
    expect(data.results.some((r) => r.title === "Oslo Office Manager")).toBe(false)
    expect(data.results.some((r) => r.title === "Stockholm Sales Lead")).toBe(false)
    expect(data.results.every((r) => r.location?.includes("Trondheim"))).toBe(true)
  })

  test("reports skipped registry rows and failed feeds in meta.errors", async () => {
    const data = await search(["-l", "area", "--format", "json"])

    expect(data.meta.errors).toContainEqual({
      employer: "Missing Ref AS",
      error: "missing ats_ref; employer skipped",
    })
    expect(data.meta.errors.some((e) => e.employer === "Fail Feed AS" && e.error.includes("fail.rss"))).toBe(
      true,
    )
  })

  test("returns nulls rather than omitting fields", async () => {
    const data = await search(["--format", "json", "--limit", "50"])
    const remote = data.results.find((r) => r.title === "Fully Remote Engineer")

    expect(remote).toBeDefined()
    expect(remote?.location).toBeNull()
    expect(Object.keys(remote ?? {}).sort()).toEqual(["company", "date", "id", "location", "title", "url"])
    expect(remote?.id).toBe("66666666-6666-4666-8666-666666666666")
    expect(remote?.url).toBe("https://alpha.teamtailor.com/jobs/1006-fully-remote-engineer")
  })
})

describe("search: query", () => {
  test("matches title and description case-insensitively", async () => {
    const data = await search(["-q", "ENGINEER", "-l", "area", "--format", "json"])
    expect(data.results.map((r) => r.title).sort()).toEqual(["Data Engineer", "Senior Engineer"])

    const norwegian = await search(["-q", "ERFARING", "-l", "area", "--format", "json"])
    expect(norwegian.results.map((r) => r.title)).toEqual(["Prosjektleder"])
  })

  test("does not match text hidden inside a script block", async () => {
    const data = await search(["-q", "hiddenkeyword", "--format", "json"])
    expect(data.meta.count).toBe(0)
    expect(data.results).toEqual([])
  })
})

describe("search: specific location", () => {
  test("matches a location city such as Heimdal", async () => {
    const data = await search(["-l", "Heimdal", "--format", "json"])
    expect(data.results.map((r) => r.title)).toEqual(["Heimdal Technician"])
  })

  test("matches name or city for Oslo", async () => {
    const data = await search(["-l", "Oslo", "--format", "json"])
    const titles = data.results.map((r) => r.title)
    expect(titles).toContain("Oslo Office Manager")
    expect(titles).toContain("Data Engineer")
    expect(titles).not.toContain("Senior Engineer")
  })
})

describe("search: job age", () => {
  test("isWithinDays filters on pubDate", () => {
    const now = new Date("2026-11-06T12:00:00Z").getTime()
    expect(isWithinDays("Wed, 04 Nov 2026 07:42:37 +0100", 7, now)).toBe(true)
    expect(isWithinDays("Wed, 28 Oct 2026 13:20:52 +0100", 7, now)).toBe(false)
    expect(isWithinDays(null, 7, now)).toBe(false)
  })

  test("the CLI accepts --jobage", async () => {
    const data = await search(["--jobage", "36500", "-l", "area", "--format", "json"])
    expect(data.meta.count).toBeGreaterThan(0)
  })
})

describe("search: pagination", () => {
  const dir = mkdtempSync(join(tmpdir(), "teamtailor-paged-"))

  function item(index: number): string {
    return `<item>
      <title>Item ${String(index).padStart(3, "0")}</title>
      <description>&lt;p&gt;Paged item ${index}&lt;/p&gt;</description>
      <pubDate>Thu, 05 Nov 2026 08:15:00 +0100</pubDate>
      <link>https://paged.teamtailor.com/jobs/${1000 + index}-item-${index}</link>
      <guid>00000000-0000-4000-8000-${String(index).padStart(12, "0")}</guid>
      <tt:locations><tt:location><tt:name>Trondheim</tt:name><tt:zip>7010</tt:zip><tt:city>Trondheim</tt:city><tt:country>Norway</tt:country></tt:location></tt:locations>
    </item>`
  }

  function feed(items: string[]): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:tt="https://teamtailor.com/locations"><channel><title>Paged</title>${items.join(
      "",
    )}</channel></rss>`
  }

  writeFileSync(
    join(dir, "employers.csv"),
    "orgnr,name,ats,ats_ref,enabled\n1,Paged AS,teamtailor,https://paged.teamtailor.com/jobs.rss,true\n",
  )
  writeFileSync(join(dir, "area.json"), readFileSync(join(FIXTURES, "area.json"), "utf8"))
  writeFileSync(join(dir, "paged.rss"), feed(Array.from({ length: 100 }, (_, i) => item(i))))
  writeFileSync(join(dir, "paged.100.rss"), feed([item(100)]))

  const env = {
    TEAMTAILOR_FIXTURE_DIR: dir,
    TEAMTAILOR_REGISTRY: join(dir, "employers.csv"),
    TEAMTAILOR_AREA: join(dir, "area.json"),
  }

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test("page 1 reads the first 100 items", async () => {
    const data = await search(["-l", "area", "--format", "json", "--limit", "250"], env)
    expect(data.meta.count).toBe(100)
    expect(data.results.some((r) => r.title === "Item 100")).toBe(false)
  })

  test("page 2 requests offset=100 and includes the second page", async () => {
    const data = await search(["-l", "area", "--page", "2", "--format", "json", "--limit", "250"], env)
    expect(data.meta.page).toBe(2)
    expect(data.meta.count).toBe(101)
    expect(data.results.some((r) => r.title === "Item 100")).toBe(true)
  })
})
