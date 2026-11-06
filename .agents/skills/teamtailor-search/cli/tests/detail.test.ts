import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fixtureEnv, parseJSON, runCLI } from "./helpers"

const POSTING = "https://alpha.teamtailor.com/jobs/1001-senior-engineer"

interface DetailResponse {
  id: string | null
  title: string | null
  company: string | null
  location: string | null
  date: string | null
  url: string | null
  description: string | null
}

describe("detail from JSON-LD", () => {
  test("parses title, company, location, date and readable description", async () => {
    const result = await runCLI(["detail", POSTING, "--format", "json"], fixtureEnv())
    const detail = parseJSON<DetailResponse>(result)

    expect(detail.id).toBe("1001")
    expect(detail.title).toBe("Senior Engineer")
    expect(detail.company).toBe("Alpha AS")
    expect(detail.location).toBe("Trondheim, Norway")
    expect(detail.date).toBe("2026-11-04")
    expect(detail.url).toBe(POSTING)
    expect(detail.description).toContain("Build great things.")
    expect(detail.description).toContain("Second paragraph.")
    expect(detail.description).toContain("One")
    expect(detail.description).toContain("Two")
    // JSON-LD wins over the fallback prose div, and hidden script text is gone.
    expect(detail.description).not.toContain("Fallback body")
    expect(detail.description).not.toContain("hidden detail text")
  })

  test("plain output is readable", async () => {
    const result = await runCLI(["detail", POSTING, "--format", "plain"], fixtureEnv())
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Senior Engineer")
    expect(result.stdout).toContain("Alpha AS · Trondheim, Norway · 2026-11-04")
    expect(result.stdout).toContain("Build great things.")
    expect(result.stdout).toContain(`URL: ${POSTING}`)
  })

  test("a bare id is rejected when several employers make it ambiguous", async () => {
    const result = await runCLI(["detail", "1001", "--format", "json"], fixtureEnv())

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe("")
    const error = JSON.parse(result.stderr)
    expect(error.code).toBe("AMBIGUOUS_ID")
  })

  test("rejects an IP-literal URL", async () => {
    const result = await runCLI(["detail", "https://127.0.0.1/jobs/x"], fixtureEnv())

    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stderr).code).toBe("BAD_URL")
  })
})

describe("detail not found", () => {
  const dir = mkdtempSync(join(tmpdir(), "teamtailor-empty-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test("an empty fixture page exits 1 with NOT_FOUND", async () => {
    const result = await runCLI(["detail", POSTING, "--format", "json"], {
      TEAMTAILOR_FIXTURE_DIR: dir,
    })

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe("")
    expect(JSON.parse(result.stderr)).toEqual({
      error: "Job posting not found (404 or empty response)",
      code: "NOT_FOUND",
    })
  })
})
