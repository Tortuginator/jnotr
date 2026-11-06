import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { FIXTURES_DIR, startServer, type TestServer } from "./server"
import { parseJSON, runCLI } from "./helpers"

let server: TestServer
let env: Record<string, string>

beforeAll(() => {
  server = startServer()
  env = {
    SMARTRECRUITERS_API_BASE: server.url,
    SMARTRECRUITERS_JOBS_BASE: server.url,
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
  test("returns meta, results and explicit nulls", async () => {
    const result = await runCLI(["search", "--format", "json"], env)
    expect(result.exitCode).toBe(0)
    const data = parseJSON<SearchJson>(result)

    expect(data.meta.count).toBe(3)
    expect(data.meta.page).toBe(1)
    expect(data.meta.totalMatched).toBe(3)
    // Aker Solutions' ats_ref=v1 is an API version, not a slug.
    expect(data.meta.errors).toHaveLength(1)
    expect(data.meta.errors[0].employer).toBe("AKER SOLUTIONS AS")

    expect(data.results).toHaveLength(3)
    for (const job of data.results) {
      expect(Object.keys(job).sort()).toEqual(["company", "date", "id", "location", "title", "url"])
      expect(job.url.startsWith("http")).toBe(true)
    }
    expect(data.results[0].company).toBe("SOPRA STERIA AS")
  })

  test("location=area keeps Trondheim and Heimdal, not Oslo", async () => {
    const result = await runCLI(["search", "-l", "area", "--format", "json"], env)
    const data = parseJSON<SearchJson>(result)
    expect(data.results.map((r) => r.id)).toEqual(["744000160192843", "744000160192845"])
    expect(data.results.every((r) => r.location?.includes("Trøndelag"))).toBe(true)
  })

  test("a specific place matches the municipality's places", async () => {
    const result = await runCLI(["search", "-l", "Trondheim", "--format", "json"], env)
    const data = parseJSON<SearchJson>(result)
    expect(data.results.map((r) => r.id)).toEqual(["744000160192843", "744000160192845"])
  })

  test("limit caps and page paginates the pooled results", async () => {
    const first = parseJSON<SearchJson>(await runCLI(["search", "--limit", "2", "--format", "json"], env))
    expect(first.meta.count).toBe(2)
    expect(first.results.map((r) => r.id)).toEqual(["744000160192843", "744000160192844"])

    const second = parseJSON<SearchJson>(
      await runCLI(["search", "--page", "2", "--limit", "2", "--format", "json"], env),
    )
    expect(second.meta.page).toBe(2)
    expect(second.meta.count).toBe(1)
    expect(second.results.map((r) => r.id)).toEqual(["744000160192845"])
  })

  test("query is sent to the API as q", async () => {
    server.requests.length = 0
    await runCLI(["search", "-q", "utvikler", "--format", "json"], env)
    expect(server.requests.some((r) => r.includes("q=utvikler"))).toBe(true)
  })

  test("an employer failure is recorded in meta.errors and does not fail the run", async () => {
    const result = await runCLI(["search", "--format", "json"], env)
    expect(result.exitCode).toBe(0)
    const data = parseJSON<SearchJson>(result)
    expect(data.meta.errors.some((e) => e.employer === "AKER SOLUTIONS AS")).toBe(true)
  })
})

describe("search formats and validation", () => {
  test("table output contains a header and rows", async () => {
    const result = await runCLI(["search", "--limit", "1", "--format", "table"], env)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("TITLE")
    expect(result.stdout).toContain("Senior systemutvikler")
  })

  test("plain output contains the URL", async () => {
    const result = await runCLI(["search", "--limit", "1", "--format", "plain"], env)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("http")
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
