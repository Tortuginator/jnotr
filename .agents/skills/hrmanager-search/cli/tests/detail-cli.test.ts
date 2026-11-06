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

interface DetailJson {
  id: string
  title: string
  company: string | null
  location: string | null
  date: string | null
  url: string
  description: string | null
}

describe("detail command", () => {
  test("parses a posting URL from search into readable text", async () => {
    const search = parseJSON<{ results: Array<{ url: string }> }>(
      await runCLI(["search", "-q", "saksbehandler", "--format", "json"], env),
    )
    const url = search.results[0].url
    const result = await runCLI(["detail", url, "--format", "json"], env)
    expect(result.exitCode).toBe(0)
    const job = parseJSON<DetailJson>(result)
    expect(job.title).toBe("Saksbehandler")
    expect(job.location).toBe("Heimdal")
    expect(job.id).toBe("149240")
    expect(job.description).toContain("På Heimdal søker vi")
    expect(job.description).toContain("Erfaring fra eiendom")
    expect(job.description).not.toContain("<li>")
  })

  test("a bare id is found by scanning the registry feeds", async () => {
    const result = await runCLI(["detail", "149240", "--format", "plain"], env)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Saksbehandler")
    expect(result.stdout).toContain("På Heimdal søker vi")
    expect(result.stdout).toContain("URL:")
  })

  test("a customer:id reference resolves directly", async () => {
    const result = await runCLI(["detail", "Sparebank1:149240", "--format", "json"], env)
    expect(result.exitCode).toBe(0)
    expect(parseJSON<DetailJson>(result).title).toBe("Saksbehandler")
  })

  test("a missing posting exits 1 with NOT_FOUND", async () => {
    const result = await runCLI(["detail", "999999", "--format", "json"], env)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe("")
    expect(JSON.parse(result.stderr).code).toBe("NOT_FOUND")
  })

  test("a foreign URL is rejected before any fetch", async () => {
    const result = await runCLI(["detail", "https://evil.example/ApplicationInit.aspx?ProjectId=1"], env)
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stderr).code).toBe("BAD_ID")
  })

  test("missing id and unknown flags exit 1", async () => {
    const missing = await runCLI(["detail"], env)
    expect(missing.exitCode).toBe(1)
    expect(JSON.parse(missing.stderr).code).toBe("NO_ID")

    const unknown = await runCLI(["detail", "1", "--bogus", "x"], env)
    expect(unknown.exitCode).toBe(1)
    expect(JSON.parse(unknown.stderr).code).toBe("UNKNOWN_FLAG")
  })
})
