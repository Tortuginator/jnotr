import { describe, test, expect } from "bun:test"
import { runCLI, runWithFixtures } from "./helpers"

function stderrJSON(stderr: string): { error?: string; code?: string } {
  try {
    return JSON.parse(stderr)
  } catch {
    return {}
  }
}

function jobsRequest(requests: URL[]): URL {
  const request = requests.find((r) => r.pathname === "/v1/Jobs")
  if (!request) throw new Error("No /v1/Jobs request was made")
  return request
}

describe("CLI contract: errors", () => {
  test("unknown flag exits 1 with JSON on stderr before any network request", async () => {
    const result = await runCLI(["search", "--bogus"])
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe("")
    const err = stderrJSON(result.stderr)
    expect(err.code).toBe("UNKNOWN_FLAG")
    expect(err.error).toContain("--bogus")
  })

  test("detail with a non-Jobbnorge URL exits 1 with BAD_ID", async () => {
    const result = await runCLI(["detail", "https://example.com/jobs/310059"])
    expect(result.exitCode).toBe(1)
    expect(stderrJSON(result.stderr).code).toBe("BAD_ID")
  })

  test("detail without an id exits 1 with NO_ID", async () => {
    const result = await runCLI(["detail"])
    expect(result.exitCode).toBe(1)
    expect(stderrJSON(result.stderr).code).toBe("NO_ID")
  })

  test("an unknown location exits 1 with BAD_LOCATION", async () => {
    const { result } = await runWithFixtures(["search", "-l", "Atlantis"])
    expect(result.exitCode).toBe(1)
    expect(stderrJSON(result.stderr).code).toBe("BAD_LOCATION")
  })

  test("an unknown command exits 1 with BAD_CMD", async () => {
    const result = await runCLI(["nonsense"])
    expect(result.exitCode).toBe(1)
    expect(stderrJSON(result.stderr).code).toBe("BAD_CMD")
  })
})

describe("CLI contract: search JSON", () => {
  test("emits meta.count/page and every required result field, with nulls present", async () => {
    const { result, requests } = await runWithFixtures([
      "search",
      "-q",
      "rådgiver",
      "-l",
      "area",
      "--limit",
      "2",
      "--format",
      "json",
    ])

    expect(result.exitCode).toBe(0)
    const output = JSON.parse(result.stdout)
    expect(output.meta.page).toBe(1)
    expect(output.meta.count).toBe(2)
    expect(output.results).toHaveLength(2)

    for (const job of output.results) {
      for (const key of ["id", "title", "company", "location", "date", "url", "deadline", "jobScope", "jobDuration", "summary"]) {
        expect(Object.prototype.hasOwnProperty.call(job, key)).toBe(true)
      }
    }

    // The search payload has no publication date; null is the honest value.
    expect(output.results[0].date).toBeNull()
    // Zero-width text from the portal never reaches the model.
    expect(output.results[0].title).not.toContain("\u200b")
    expect(output.results[0].company).toBe("NORGES TEKNISK-NATURVITENSKAPELIGE UNIVERSITET NTNU")

    const request = jobsRequest(requests)
    expect(request.searchParams.get("term")).toBe("rådgiver")
    expect(request.searchParams.getAll("municipality")).toEqual(["5001", "5031", "5028", "5029", "5035"])
    expect(request.searchParams.get("page")).toBe("0")
    expect(request.searchParams.get("results")).toBe("2")
    expect(request.searchParams.get("orderby")).toBe("Published")
  })

  test("table and plain formats are readable", async () => {
    const table = await runWithFixtures(["search", "-q", "rådgiver", "--limit", "1", "--format", "table"])
    expect(table.result.exitCode).toBe(0)
    expect(table.result.stdout).toContain("TITLE")
    expect(table.result.stdout).toContain("COMPANY")
    expect(table.result.stdout).toContain("Professor")

    const plain = await runWithFixtures(["search", "-q", "rådgiver", "--limit", "1", "--format", "plain"])
    expect(plain.result.exitCode).toBe(0)
    expect(plain.result.stdout).toContain("id: 310059")
    expect(plain.result.stdout).toContain("https://www.jobbnorge.no/ledige-stillinger/stilling/310059")
  })
})

describe("CLI location mapping", () => {
  test("-l area sends all five municipality codes", async () => {
    const { result, requests } = await runWithFixtures(["search", "-l", "area", "--limit", "1"])
    expect(result.exitCode).toBe(0)
    expect(jobsRequest(requests).searchParams.getAll("municipality")).toEqual([
      "5001",
      "5031",
      "5028",
      "5029",
      "5035",
    ])
  })

  test("-l Trondheim resolves to municipality 5001", async () => {
    const { result, requests } = await runWithFixtures(["search", "-l", "Trondheim", "--limit", "1"])
    expect(result.exitCode).toBe(0)
    const request = jobsRequest(requests)
    expect(request.searchParams.getAll("municipality")).toEqual(["5001"])
    expect(request.searchParams.getAll("county")).toEqual([])
  })

  test("-l Trøndelag resolves to county 50", async () => {
    const { result, requests } = await runWithFixtures(["search", "-l", "Trøndelag", "--limit", "1"])
    expect(result.exitCode).toBe(0)
    const request = jobsRequest(requests)
    expect(request.searchParams.getAll("county")).toEqual(["50"])
    expect(request.searchParams.getAll("municipality")).toEqual([])
  })

  test("no location searches nationwide without the county list", async () => {
    const { result, requests } = await runWithFixtures(["search", "-q", "utvikler", "--limit", "1"])
    expect(result.exitCode).toBe(0)
    expect(requests.some((r) => r.pathname === "/v1/County")).toBe(false)
    const request = jobsRequest(requests)
    expect(request.searchParams.getAll("municipality")).toEqual([])
    expect(request.searchParams.getAll("county")).toEqual([])
  })
})

describe("CLI jobage and paging mapping", () => {
  test("--jobage 1 uses Period=Day", async () => {
    const { result, requests } = await runWithFixtures(["search", "--jobage", "1", "--limit", "1"])
    expect(result.exitCode).toBe(0)
    expect(jobsRequest(requests).searchParams.get("period")).toBe("Day")
    expect(JSON.parse(result.stdout).meta.note).toBeUndefined()
  })

  test("--jobage 30 uses Period=Week and reports the approximation", async () => {
    const { result, requests } = await runWithFixtures(["search", "--jobage", "30", "--limit", "1"])
    expect(result.exitCode).toBe(0)
    expect(jobsRequest(requests).searchParams.get("period")).toBe("Week")
    expect(JSON.parse(result.stdout).meta.note).toContain("7-day")
  })

  test("--page 2 maps to the API's 0-indexed page=1", async () => {
    const { result, requests } = await runWithFixtures(["search", "--page", "2", "--limit", "1"])
    expect(result.exitCode).toBe(0)
    expect(jobsRequest(requests).searchParams.get("page")).toBe("1")
    expect(JSON.parse(result.stdout).meta.page).toBe(2)
  })
})

describe("CLI contract: detail", () => {
  test("detail emits metadata and a cleaned description", async () => {
    const { result } = await runWithFixtures(["detail", "310059", "--format", "json"])
    expect(result.exitCode).toBe(0)

    const job = JSON.parse(result.stdout)
    expect(job.id).toBe("310059")
    expect(job.title).toBe("Professor/Associate Professor in Hydropower Technologies")
    expect(job.company).toBe("NORGES TEKNISK-NATURVITENSKAPELIGE UNIVERSITET NTNU")
    expect(job.location).toBe("Trondheim")
    expect(job.deadline).toBe("2026-12-04")
    expect(job.employmentType).toBe("Heltid / Fast")
    expect(job.language).toBe("en")
    expect(job.isActive).toBe(true)
    expect(job.description).toContain("The Department of Energy")
    expect(job.description).toContain("About the position")
    expect(job.description).toContain("Item one")
    expect(job.description).not.toContain("hidden instruction")
    expect(job.description).not.toContain("alert")
  })

  test("detail accepts a posting URL", async () => {
    const { result } = await runWithFixtures([
      "detail",
      "https://www.jobbnorge.no/ledige-stillinger/stilling/310059",
      "--format",
      "json",
    ])
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout).id).toBe("310059")
  })

  test("detail plain output is readable", async () => {
    const { result } = await runWithFixtures(["detail", "310059", "--format", "plain"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Professor/Associate Professor in Hydropower Technologies")
    expect(result.stdout).toContain("Deadline: 2026-12-04")
    expect(result.stdout).toContain("About the position")
    expect(result.stdout).toContain("URL: https://www.jobbnorge.no/ledige-stillinger/stilling/310059")
  })

  test("a 404 detail exits 1 with NOT_FOUND", async () => {
    const { result } = await runWithFixtures(["detail", "404"])
    expect(result.exitCode).toBe(1)
    expect(stderrJSON(result.stderr).code).toBe("NOT_FOUND")
  })
})
