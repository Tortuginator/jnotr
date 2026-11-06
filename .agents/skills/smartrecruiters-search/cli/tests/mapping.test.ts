import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { FIXTURES_DIR } from "./server"
import {
  mapDetail,
  mapPosting,
  normalizeDetailInput,
  parseDetailDescription,
  type Employer,
  type SRDetail,
  type SRPostingsResponse,
} from "../src/helpers"

const employer: Employer = {
  row: 2,
  orgnr: "1",
  name: "SOPRA STERIA AS",
  aliases: [],
  trdStaff: "229",
  nace: "62.200",
  website: "",
  careerUrl: "",
  ats: "smartrecruiters",
  atsRef: "SopraSteria1",
  confidence: "high",
  enabled: true,
}

describe("posting mapping", () => {
  const payload = JSON.parse(readFileSync(join(FIXTURES_DIR, "postings.json"), "utf8")) as SRPostingsResponse

  test("maps every required field and normalizes company to the registry name", () => {
    const mapped = mapPosting(payload.content[0], employer, "SopraSteria1")
    expect(mapped.result).toEqual({
      id: "744000160192843",
      title: "Senior systemutvikler",
      company: "SOPRA STERIA AS",
      location: "Trondheim, Trøndelag, Norway",
      date: "2026-11-05",
      url: "https://jobs.smartrecruiters.com/SopraSteria1/744000160192843",
    })
    expect(mapped.loc.city).toBe("Trondheim")
    expect(mapped.loc.postalCode).toBe("7010")
  })

  test("null fields are explicit, never omitted", () => {
    const mapped = mapPosting(
      { id: "1", name: "No location" },
      { ...employer, name: "" },
      "SopraSteria1",
    )
    expect(mapped.result.company).toBeNull()
    expect(mapped.result.location).toBeNull()
    expect(mapped.result.date).toBeNull()
    expect(Object.keys(mapped.result).sort()).toEqual(["company", "date", "id", "location", "title", "url"])
  })
})

describe("detail mapping", () => {
  const detail = JSON.parse(readFileSync(join(FIXTURES_DIR, "detail.json"), "utf8")) as SRDetail

  test("concatenates readable sections with headings and paragraph breaks", () => {
    const description = parseDetailDescription(detail)!
    expect(description).toContain("Company Description")
    expect(description).toContain("Sopra Steria er et ledende teknologiselskap.")
    expect(description).toContain("Job Description")
    expect(description).toContain("Vi søker en senior systemutvikler.")
    expect(description).toContain("5 års erfaring")
    expect(description).toContain("\n\n")
    expect(description).not.toContain("<p>")
  })

  test("maps detail fields", () => {
    const job = mapDetail(detail, "SOPRA STERIA AS", "SopraSteria1")
    expect(job.title).toBe("Senior systemutvikler")
    expect(job.company).toBe("SOPRA STERIA AS")
    expect(job.location).toBe("Trondheim, Trøndelag, Norway")
    expect(job.date).toBe("2026-11-05")
    expect(job.refNumber).toBe("REF100")
    expect(job.department).toBe("Application Development")
    expect(job.employmentType).toBe("Full-time")
    expect(job.description).toContain("senior systemutvikler")
  })
})

describe("detail input normalization", () => {
  test("accepts ids, public URLs, API URLs and slug:id", () => {
    expect(normalizeDetailInput("744000160192843")).toEqual({ slug: null, id: "744000160192843" })
    expect(
      normalizeDetailInput("https://jobs.smartrecruiters.com/SopraSteria1/744000160192843-senior-systemutvikler"),
    ).toEqual({ slug: "SopraSteria1", id: "744000160192843" })
    expect(
      normalizeDetailInput("https://api.smartrecruiters.com/v1/companies/SopraSteria1/postings/744000160192843"),
    ).toEqual({ slug: "SopraSteria1", id: "744000160192843" })
    expect(normalizeDetailInput("SopraSteria1:744000160192843")).toEqual({
      slug: "SopraSteria1",
      id: "744000160192843",
    })
  })

  test("rejects foreign hosts and malformed input", () => {
    expect(normalizeDetailInput("https://evil.example/jobs/744000160192843")).toBeNull()
    expect(normalizeDetailInput("https://jobs.smartrecruiters.com/")).toBeNull()
    expect(normalizeDetailInput("")).toBeNull()
  })
})
