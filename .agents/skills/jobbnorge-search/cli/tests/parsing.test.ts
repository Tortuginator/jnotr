import { describe, test, expect } from "bun:test"
import {
  AREA_MUNICIPALITIES,
  LocationError,
  buildEmployerIndex,
  htmlToText,
  normalizeDate,
  parseCsv,
  parseJob,
  locationMatchesNames,
  locationNamesForFilter,
  parseJobDetail,
  resolveLocation,
  stripInvisible,
  type County,
  type JobContent,
  type JobInfo,
  type RawJob,
} from "../src/helpers"
import { buildSearchUrl, periodForJobage, requestSize, type SearchOpts } from "../src/commands/search"
import { normalizeId } from "../src/commands/detail"
import counties from "./fixtures/county.json"
import jobInfo from "./fixtures/job-info.json"
import jobContent from "./fixtures/joblisting.json"
import jobs from "./fixtures/jobs.json"

const countyList = counties as County[]

const registryCsv = [
  "orgnr,name,aliases,enabled",
  "974767880,NORGES TEKNISK-NATURVITENSKAPELIGE UNIVERSITET NTNU,,true",
  "883974832,ST. OLAVS HOSPITAL HF,ST OLAVS HOSPITAL|ST. OLAVS HOSPITAL,true",
  "919303808,SINTEF AS,,true",
  "937357370,SINTEF OCEAN AS,,true",
].join("\n")

describe("CSV and employer normalisation", () => {
  test("parses quoted fields containing commas", () => {
    const rows = parseCsv('name,aliases\r\n"Kommune, Trondheim",TRONDHEIM|TRONDHEIM KOMMUNE\r\n')
    expect(rows[1][0]).toBe("Kommune, Trondheim")
    expect(rows[1][1]).toBe("TRONDHEIM|TRONDHEIM KOMMUNE")
  })

  test("matches NTNU despite word order and legal suffix", () => {
    const index = buildEmployerIndex([registryCsv])
    expect(index.resolve("NTNU - Norges teknisk-naturvitenskapelige universitet")).toBe(
      "NORGES TEKNISK-NATURVITENSKAPELIGE UNIVERSITET NTNU",
    )
    expect(index.resolve("NTNU")).toBe("NORGES TEKNISK-NATURVITENSKAPELIGE UNIVERSITET NTNU")
  })

  test("matches aliases case-insensitively", () => {
    const index = buildEmployerIndex([registryCsv])
    expect(index.resolve("St. Olavs Hospital")).toBe("ST. OLAVS HOSPITAL HF")
    expect(index.resolve("st olavs hospital")).toBe("ST. OLAVS HOSPITAL HF")
  })

  test("does not let SINTEF AS absorb SINTEF OCEAN AS", () => {
    const index = buildEmployerIndex([registryCsv])
    expect(index.resolve("SINTEF AS")).toBe("SINTEF AS")
    expect(index.resolve("SINTEF Ocean AS")).toBe("SINTEF OCEAN AS")
  })

  test("keeps an unmatched employer unchanged", () => {
    const index = buildEmployerIndex([registryCsv])
    expect(index.resolve("Sikt - Kunnskapssektorens tjenesteleverandor")).toBe(
      "Sikt - Kunnskapssektorens tjenesteleverandor",
    )
  })
})

describe("date normalisation", () => {
  test("normalises the API's dd.mm.yyyy deadline", () => {
    expect(normalizeDate("04.12.2026")).toBe("2026-12-04")
    expect(normalizeDate("4.2.2026")).toBe("2026-02-04")
  })

  test("normalises the detail endpoint's $date(...) wrapper", () => {
    expect(normalizeDate("$date('2026-12-04 00:00:00')")).toBe("2026-12-04")
  })

  test("returns null for missing dates", () => {
    expect(normalizeDate(null)).toBeNull()
    expect(normalizeDate("")).toBeNull()
    expect(normalizeDate("not a date")).toBeNull()
  })
})

describe("HTML to text", () => {
  test("removes hidden, script and comment text but keeps visible paragraphs and lists", () => {
    const html = "<p>Visible&nbsp;text</p><div hidden>secret</div><script>alert(1)</script><!-- comment --><ul><li>One</li><li>Two</li></ul>"
    const text = htmlToText(html)
    expect(text).toContain("Visible text")
    expect(text).toContain("One")
    expect(text).toContain("Two")
    expect(text).not.toContain("secret")
    expect(text).not.toContain("alert")
    expect(text).not.toContain("comment")
  })

  test("stripInvisible removes zero-width characters from nested output", () => {
    const value = stripInvisible({ title: "Rådgiver\u200b", nested: ["a\u200bb"] })
    expect(value.title).toBe("Rådgiver")
    expect(value.nested[0]).toBe("ab")
  })
})

describe("search result parsing", () => {
  const employers = buildEmployerIndex([registryCsv])

  test("maps the contract fields and never omits a null", () => {
    const job = parseJob(jobs[0] as RawJob, employers)
    expect(job).not.toBeNull()
    expect(Object.keys(job!).sort()).toEqual(
      ["company", "date", "deadline", "id", "jobDuration", "jobScope", "location", "summary", "title", "url"].sort(),
    )
    expect(job!.id).toBe("310059")
    expect(job!.title).toContain("Hydropower")
    expect(job!.company).toBe("NORGES TEKNISK-NATURVITENSKAPELIGE UNIVERSITET NTNU")
    expect(job!.location).toBe("Trondheim")
    expect(job!.date).toBeNull()
    expect(job!.deadline).toBe("2026-12-04")
    expect(job!.url).toBe("https://www.jobbnorge.no/ledige-stillinger/stilling/310059")
  })

  test("falls back to the canonical URL when the API omits link", () => {
    const job = parseJob({ id: 123, title: "Test", employer: "X" }, employers)
    expect(job!.url).toBe("https://www.jobbnorge.no/ledige-stillinger/stilling/123")
  })

  test("drops a result without a title instead of emitting an empty card", () => {
    expect(parseJob({ id: 1, title: "  " }, employers)).toBeNull()
  })

  test("decodes entities in titles and summaries", () => {
    const job = parseJob(jobs[1] as RawJob, employers)
    expect(job!.title).toBe("Rådgiver økonomi - virksomhetskontroller")
    expect(job!.summary).toContain("rådgiver")
  })
})

describe("location resolution", () => {
  test("area expands to the five commute municipalities", () => {
    const filter = resolveLocation("area", countyList)
    expect(filter.municipalities).toEqual([...AREA_MUNICIPALITIES])
    expect(filter.counties).toEqual([])
  })

  test("resolves a municipality name", () => {
    expect(resolveLocation("Trondheim", countyList).municipalities).toEqual([5001])
    expect(resolveLocation("Stjordal", countyList).municipalities).toEqual([5035])
    expect(resolveLocation("Trondheim kommune", countyList).municipalities).toEqual([5001])
  })

  test("resolves a county name, with or without diacritics and suffix", () => {
    expect(resolveLocation("Trøndelag", countyList).counties).toEqual([50])
    expect(resolveLocation("Trondelag", countyList).counties).toEqual([50])
    expect(resolveLocation("Trøndelag fylke", countyList).counties).toEqual([50])
  })

  test("accepts numeric codes", () => {
    expect(resolveLocation("5001", countyList).municipalities).toEqual([5001])
    expect(resolveLocation("301", countyList).municipalities).toEqual([301])
    expect(resolveLocation("50", countyList).counties).toEqual([50])
  })

  test("rejects an unknown place instead of searching nationwide", () => {
    expect(() => resolveLocation("Atlantis", countyList)).toThrow(LocationError)
  })
})

describe("location post-filter", () => {
  const areaFile = {
    municipalities: [
      { code: "5001", name: "Trondheim", places: ["Heimdal", "Ranheim"] },
      { code: "5029", name: "Skaun", places: ["Venn", "Buvika"] },
    ],
  }
  const filter = { municipalities: [5001, 5031, 5028, 5029, 5035], counties: [], label: "area" }
  const names = locationNamesForFilter(filter, countyList, areaFile)

  test("accepts municipality and place names", () => {
    expect(locationMatchesNames("Trondheim", names)).toBe(true)
    expect(locationMatchesNames("Buvika, Skaun", names)).toBe(true)
    expect(locationMatchesNames("Heimdal", names)).toBe(true)
  })

  test("rejects out-of-area and generic locations", () => {
    expect(locationMatchesNames("Bodø", names)).toBe(false)
    expect(locationMatchesNames("Vennesla", names)).toBe(false)
    expect(locationMatchesNames("Flere", names)).toBe(false)
    expect(locationMatchesNames(null, names)).toBe(false)
  })
})

describe("jobage and search URL mapping", () => {
  const base: SearchOpts = { page: 1, format: "json" }

  test("jobage 1 uses Day and larger values use Week with a note", () => {
    expect(periodForJobage(undefined)).toEqual({ period: null })
    expect(periodForJobage(1)).toEqual({ period: "Day" })
    expect(periodForJobage(7).period).toBe("Week")
    expect(periodForJobage(30).note).toContain("7-day")
  })

  test("sizes the request from --limit and caps it at 100", () => {
    expect(requestSize(undefined)).toBe(50)
    expect(requestSize(5)).toBe(5)
    expect(requestSize(500)).toBe(100)
  })

  test("maps query, location, page and period to API parameters", () => {
    const filter = resolveLocation("area", countyList)
    const url = new URL(buildSearchUrl({ ...base, query: "rådgiver", jobage: 7, page: 2, limit: 5 }, filter))
    expect(url.origin + url.pathname).toBe("https://publicapi.jobbnorge.no/v1/Jobs")
    expect(url.searchParams.get("term")).toBe("rådgiver")
    expect(url.searchParams.getAll("municipality")).toEqual(["5001", "5031", "5028", "5029", "5035"])
    expect(url.searchParams.get("period")).toBe("Week")
    // The CLI is 1-indexed; the API is 0-indexed.
    expect(url.searchParams.get("page")).toBe("1")
    expect(url.searchParams.get("results")).toBe("5")
    expect(url.searchParams.get("orderby")).toBe("Published")
  })

  test("maps a county filter to the county parameter", () => {
    const filter = resolveLocation("Trøndelag", countyList)
    const url = new URL(buildSearchUrl({ ...base }, filter))
    expect(url.searchParams.getAll("county")).toEqual(["50"])
    expect(url.searchParams.getAll("municipality")).toEqual([])
  })
})

describe("detail input and parsing", () => {
  test("accepts numeric ids and Jobbnorge URLs only", () => {
    expect(normalizeId("310059")).toBe("310059")
    expect(normalizeId("https://www.jobbnorge.no/ledige-stillinger/stilling/310059")).toBe("310059")
    expect(normalizeId("https://www.jobbnorge.no/ledige-stillinger/stilling/310059/professor-slug")).toBe("310059")
    expect(normalizeId("jobbnorge.no/ledige-stillinger/stilling/310059")).toBe("310059")
    expect(normalizeId("https://example.com/ledige-stillinger/stilling/310059")).toBeNull()
    expect(normalizeId("not-an-id")).toBeNull()
  })

  test("parses detail metadata and a readable description", () => {
    const employers = buildEmployerIndex([registryCsv])
    const job = parseJobDetail(
      "310059",
      jobInfo as JobInfo,
      jobContent as JobContent,
      employers,
      2,
    )

    expect(job.id).toBe("310059")
    expect(job.title).toBe("Professor/Associate Professor in Hydropower Technologies")
    expect(job.company).toBe("NORGES TEKNISK-NATURVITENSKAPELIGE UNIVERSITET NTNU")
    expect(job.location).toBe("Trondheim")
    expect(job.deadline).toBe("2026-12-04")
    expect(job.employmentType).toBe("Heltid / Fast")
    expect(job.positionCount).toBe(1)
    expect(job.isActive).toBe(true)
    expect(job.language).toBe("en")
    expect(job.contacts[0].email).toBe("ole.g.dahlhaug@ntnu.no")
    expect(job.description).toContain("The Department")
    expect(job.description).toContain("About the position")
    expect(job.description).toContain("Item one")
    expect(job.description).not.toContain("hidden instruction")
    expect(job.description).not.toContain("alert")
  })
})
