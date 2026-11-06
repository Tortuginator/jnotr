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
  test("a bare numeric ID is found across registry slugs", async () => {
    const result = await runCLI(["detail", "744000160192843", "--format", "json"], env)
    expect(result.exitCode).toBe(0)
    const job = parseJSON<DetailJson>(result)
    expect(job.title).toBe("Senior systemutvikler")
    expect(job.company).toBe("SOPRA STERIA AS")
    expect(job.description).toContain("senior systemutvikler")
    expect(job.description).toContain("5 års erfaring")
  })

  test("a public URL resolves the slug directly", async () => {
    const result = await runCLI(
      ["detail", "https://jobs.smartrecruiters.com/SopraSteria1/744000160192843-senior", "--format", "plain"],
      env,
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Senior systemutvikler")
    expect(result.stdout).toContain("Job Description")
    expect(result.stdout).toContain("URL:")
  })

  test("a missing posting exits 1 with NOT_FOUND", async () => {
    const result = await runCLI(["detail", "999999999", "--format", "json"], env)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe("")
    expect(JSON.parse(result.stderr).code).toBe("NOT_FOUND")
  })

  test("a foreign URL is rejected before any fetch", async () => {
    const result = await runCLI(["detail", "https://evil.example/744000160192843"], env)
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
