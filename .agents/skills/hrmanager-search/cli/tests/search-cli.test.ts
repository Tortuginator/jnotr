import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { FIXTURES_DIR, startServer, type TestServer } from "./server"
import { parseJSON, runCLI } from "./helpers"

let server: TestServer
let env: Record<string, string>

beforeAll(() => {
  server = startServer()
  env = {
    HRMANAGER_API_BASE: server.url,
    HRMANAGER_CANDIDATE_BASE: server.url,
    JOB_SCRAPER_DIR: FIXTURES_DIR,
  }
})

afterAll(() => server.stop())

interface SearchJson {
  meta: { count: number; page: number; totalMatched: number; errors: Array<{ employer: string; error: string }> }
  results: Array<{
    id: string
    title: string
    company: string | null
    location: string | null
    date: string | null
    url: string
  }>
}

describe("search JSON contract", () => {
  test("pools feeds, normalizes company and reports a failing cid", async () => {
    const result = await runCLI(["search", "--format", "json"], env)
    expect(result.exitCode).toBe(0)
    const data = parseJSON<SearchJson>(result)

    expect(data.meta.count).toBe(5)
    expect(data.meta.totalMatched).toBe(5)
    expect(data.meta.errors).toHaveLength(1)
    expect(data.meta.errors[0].employer).toBe("GK NORGE AS")
    expect(data.meta.errors[0].error).toContain("cid=139")

    const companies = new Set(data.results.map((r) => r.company))
    expect(companies).toEqual(new Set(["SPAREBANK 1 SMN", "MUSEENE I SØR-TRØNDELAG AS"]))
    for (const job of data.results) {
      expect(Object.keys(job).sort()).toEqual(["company", "date", "id", "location", "title", "url"])
    }
  })

  test("area filter keeps only the Heimdal posting", async () => {
    const data = parseJSON<SearchJson>(await runCLI(["search", "-l", "area", "--format", "json"], env))
    expect(data.results).toHaveLength(1)
    expect(data.results[0].id).toBe("149240")
    expect(data.results[0].location).toBe("Heimdal")
  })

  test("a specific place matches the municipality's places", async () => {
    const data = parseJSON<SearchJson>(await runCLI(["search", "-l", "Trondheim", "--format", "json"], env))
    expect(data.results.map((r) => r.id)).toEqual(["149240"])
  })

  test("query matches title and description client-side", async () => {
    const data = parseJSON<SearchJson>(await runCLI(["search", "-q", "utvikler", "--format", "json"], env))
    expect(data.results.map((r) => r.id)).toEqual(["149241"])

    const java = parseJSON<SearchJson>(await runCLI(["search", "-q", "Java", "--format", "json"], env))
    expect(java.results.map((r) => r.id)).toEqual(["149241"])
  })

  test("limit caps and page paginates the pooled result set", async () => {
    const first = parseJSON<SearchJson>(await runCLI(["search", "--limit", "2", "--format", "json"], env))
    expect(first.meta.count).toBe(2)
    expect(first.meta.totalMatched).toBe(5)

    const second = parseJSON<SearchJson>(
      await runCLI(["search", "--page", "2", "--limit", "2", "--format", "json"], env),
    )
    expect(second.meta.page).toBe(2)
    expect(second.meta.count).toBe(2)
  })

  test("results are sorted newest first", async () => {
    const data = parseJSON<SearchJson>(await runCLI(["search", "--format", "json"], env))
    expect(data.results[0].date).toBe("2026-11-05")
    for (let i = 1; i < data.results.length; i++) {
      expect((data.results[i - 1].date ?? "") >= (data.results[i].date ?? "")).toBe(true)
    }
  })
})

describe("search formats and validation", () => {
  test("table output contains a header and rows", async () => {
    const result = await runCLI(["search", "--limit", "1", "--format", "table"], env)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("TITLE")
    expect(result.stdout).toContain("Saksbehandler")
  })

  test("plain output contains the posting URL", async () => {
    const result = await runCLI(["search", "--limit", "1", "--format", "plain"], env)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("ApplicationInit.aspx")
  })

  test("unknown flag exits 1 with a JSON error on stderr", async () => {
    const result = await runCLI(["search", "--bogus", "x"], env)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe("")
    expect(JSON.parse(result.stderr)).toMatchObject({ code: "UNKNOWN_FLAG" })
  })

  test("bad format exits 1", async () => {
    const result = await runCLI(["search", "--format", "xml"], env)
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stderr).code).toBe("BAD_ARG")
  })

  test("bad numeric flags exit 1", async () => {
    for (const args of [
      ["search", "--limit", "0"],
      ["search", "--page", "0"],
      ["search", "--jobage", "1.5"],
    ]) {
      const result = await runCLI(args, env)
      expect(result.exitCode).toBe(1)
      expect(JSON.parse(result.stderr).code).toBe("BAD_ARG")
    }
  })
})
