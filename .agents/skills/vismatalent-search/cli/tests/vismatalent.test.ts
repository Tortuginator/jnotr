import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  MissingRegistryError,
  filterEmployers,
  fold,
  isWithinDays,
  jobUrl,
  loadArea,
  locationMatches,
  parseCsv,
  parseJob,
  resolveSiteGuid,
  type Employer,
  type VismaJob,
} from "../src/helpers"
import { buildSearchResponse, collectResults, type SearchDeps } from "../src/commands/search"
import { findJob, normalizeTarget, toJobDetail } from "../src/commands/detail"

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8")
const jobs = JSON.parse(fixture("jobs.json")) as VismaJob[]

const SITE = "0ceb6ff0-777f-4216-93b6-be2d4ae34a16"
const G1 = "11111111-1111-4111-8111-111111111111"
const G2 = "22222222-2222-4222-8222-222222222222"
const G3 = "33333333-3333-4333-8333-333333333333"
const G4 = "44444444-4444-4444-8444-444444444444"
const MISSING = "00000000-0000-4000-8000-000000000000"

const baseEmployer: Employer = {
  orgnr: "938752648",
  name: "NORTURA SA",
  aliases: "",
  website: "www.nortura.no",
  careerUrl: "https://www.nortura.no/jobb-i-nortura",
  ats: "vismatalent",
  atsRef: `https://hire.vismatalent.com/spa/nb/public/careers/${SITE}`,
  confidence: "high",
  enabled: true,
}

const area = loadArea()

const makeDeps = (overrides: Partial<SearchDeps> = {}): SearchDeps => ({
  employers: [baseEmployer],
  area,
  fetchText: async (url: string) => (url.includes(SITE) ? fixture("jobs.json") : null),
  ...overrides,
})

describe("registry", () => {
  test("parseCsv handles quoted fields and escaped quotes", () => {
    expect(parseCsv('a,b\n"x,y","he said ""hi"""\n')).toEqual([
      ["a", "b"],
      ["x,y", 'he said "hi"'],
    ])
  })

  test("filterEmployers keeps only enabled Visma Talent rows", () => {
    const rows: Employer[] = [
      baseEmployer,
      { ...baseEmployer, name: "DISABLED", enabled: false },
      { ...baseEmployer, name: "OTHER", ats: "webcruiter" },
    ]
    expect(filterEmployers(rows, "vismatalent").map((row) => row.name)).toEqual(["NORTURA SA"])
  })
})

describe("site GUID extraction", () => {
  test("takes the last path segment of a career URL or a bare GUID", () => {
    expect(resolveSiteGuid(`https://hire.vismatalent.com/spa/nb/public/careers/${SITE}`)).toBe(SITE)
    expect(resolveSiteGuid(SITE)).toBe(SITE)
    expect(resolveSiteGuid(SITE.toUpperCase())).toBe(SITE)
  })

  test("returns null when no GUID is present", () => {
    expect(resolveSiteGuid("")).toBeNull()
    expect(resolveSiteGuid("companylock=7254")).toBeNull()
  })
})

describe("detail target forms", () => {
  test("accepts siteGuid:jobGuid", () => {
    expect(normalizeTarget(`${SITE}:${G1}`)).toEqual({
      siteGuid: SITE,
      jobGuid: G1,
      url: jobUrl(G1),
    })
  })

  test("accepts a bare job GUID", () => {
    expect(normalizeTarget(G2)).toEqual({ siteGuid: null, jobGuid: G2, url: jobUrl(G2) })
  })

  test("reads guidAssignment from a public assignment URL", () => {
    expect(
      normalizeTarget(`https://hire.vismatalent.com/Public/Assignment.aspx?guidAssignment=${G1}&language=nb`),
    ).toMatchObject({ siteGuid: null, jobGuid: G1 })
  })

  test("reads siteGuid from a query parameter or a careers path segment", () => {
    expect(
      normalizeTarget(`https://hire.vismatalent.com/spa/nb/public/careers/${SITE}?guidAssignment=${G1}`),
    ).toMatchObject({ siteGuid: SITE, jobGuid: G1 })
    expect(
      normalizeTarget(`https://hire.vismatalent.com/Public/Assignment.aspx?siteGuid=${SITE}&guidAssignment=${G1}`),
    ).toMatchObject({ siteGuid: SITE, jobGuid: G1 })
  })

  test("rejects malformed ids and non-Visma hosts", () => {
    expect(normalizeTarget("nope")).toBeNull()
    expect(normalizeTarget("https://evil.example/Public/Assignment.aspx?guidAssignment=" + G1)).toBeNull()
  })
})

describe("job field mapping", () => {
  test("maps the verified schema and strips hidden description markup", () => {
    const parsed = parseJob(jobs[0], SITE, "NORTURA SA")
    expect(parsed).not.toBeNull()
    expect(parsed!.result).toEqual({
      id: `${SITE}:${G1}`,
      title: "Linjeleder kantine",
      company: "NORTURA SA",
      location: "Stavanger",
      date: "2026-11-02",
      url: jobUrl(G1),
    })
    expect(parsed!.employmentType).toBe("Fast ansettelse")
    expect(parsed!.department).toBe("Forus")
    expect(parsed!.published).toBe("2026-11-02")
    expect(parsed!.endDate).toBe("2026-11-30")
    expect(parsed!.locationText).toContain("Stavanger")
    expect(parsed!.locationText).toContain("Rogaland")
    expect(fold(parsed!.queryText)).toContain("kantine")
    expect(parsed!.queryText).not.toContain("Hidden instruction")
    expect(parsed!.queryText).not.toContain("ignoreMe")
  })

  test("keeps every contract field, with nulls, when Assignment is missing", () => {
    const parsed = parseJob(jobs[2], SITE, "NORTURA SA")!
    expect(parsed.result).toEqual({
      id: `${SITE}:${G3}`,
      title: "(untitled)",
      company: "NORTURA SA",
      location: null,
      date: "2026-09-01",
      url: jobUrl(G3),
    })
    expect(Object.keys(parsed.result).sort()).toEqual(["company", "date", "id", "location", "title", "url"])
    expect(parsed.description).toBeNull()
  })

  test("ignores extra fields and joins multiple departments", () => {
    const parsed = parseJob(jobs[3], SITE, "NORTURA SA")!
    expect(parsed.result.location).toBe("Bergen")
    expect(parsed.department).toBeNull()
    expect(parsed.employmentType).toBe("Vikariat")

    const multi = parseJob(jobs[1], SITE, "NORTURA SA")!
    expect(multi.department).toBe("Teknologi, Digital")
    expect(multi.result.date).toBe("2026-11-01")
  })
})

describe("query, location and date filters", () => {
  const now = new Date("2026-11-06T12:00:00Z")

  test("query matches title and description case-insensitively", async () => {
    const { results } = await collectResults({ page: 1, query: "UTVIKLER", format: "json", now }, makeDeps())
    expect(results.map((result) => result.title)).toEqual(["Utvikler"])
  })

  test("area matches only the Trondheim fixture", async () => {
    const { results } = await collectResults({ page: 1, location: "area", format: "json", now }, makeDeps())
    expect(results.map((result) => result.title)).toEqual(["Utvikler"])
  })

  test("a specific place and county match their postings", async () => {
    const stavanger = await collectResults({ page: 1, location: "Stavanger", format: "json", now }, makeDeps())
    expect(stavanger.results.map((result) => result.title)).toEqual(["Linjeleder kantine"])

    const rogaland = await collectResults({ page: 1, location: "Rogaland", format: "json", now }, makeDeps())
    expect(rogaland.results.map((result) => result.title)).toEqual(["Linjeleder kantine"])
  })

  test("diacritics fold for matching", () => {
    expect(fold("TRØNDELAG")).toBe("trondelag")
    expect(locationMatches("Trøndelag", "trondelag", area)).toBe(true)
  })

  test("does not match short place names inside longer words", () => {
    expect(locationMatches("Vennesla", "area", area)).toBe(false)
    expect(locationMatches("Vennesla", "Skaun", area)).toBe(false)
    expect(locationMatches("kvalifisering", "area", area)).toBe(false)
    expect(locationMatches("Ryen, Oslo", "Trondheim", area)).toBe(false)
  })

  test("jobage filters on PublishStartDate", async () => {
    const week = await collectResults({ page: 1, jobage: 7, format: "json", now }, makeDeps())
    expect(week.results.map((result) => result.title).sort()).toEqual([
      "Linjeleder kantine",
      "Selger",
      "Utvikler",
    ])

    const days = await collectResults({ page: 1, jobage: 3, format: "json", now }, makeDeps())
    expect(days.results.map((result) => result.title)).toEqual(["Selger"])
  })

  test("isWithinDays uses the current UTC day", () => {
    expect(isWithinDays("2026-11-01", 7, now)).toBe(true)
    expect(isWithinDays("2026-09-01", 7, now)).toBe(false)
  })
})

describe("pooling, errors and output contract", () => {
  test("fails with NO_REGISTRY semantics when no registry file was loaded", async () => {
    await expect(collectResults({ page: 1, format: "json" }, makeDeps({ employers: null }))).rejects.toBeInstanceOf(
      MissingRegistryError,
    )
  })

  test("records a failing employer in meta.errors without failing the run", async () => {
    const broken: Employer = { ...baseEmployer, name: "BROKEN", atsRef: "" }
    const { results, errors } = await collectResults({ page: 1, format: "json" }, makeDeps({ employers: [baseEmployer, broken] }))
    expect(results).toHaveLength(4)
    expect(errors).toHaveLength(1)
    expect(errors[0].employer).toBe("BROKEN")
    expect(errors[0].error).toContain("no siteGuid")
  })

  test("buildSearchResponse emits the documented JSON shape with explicit nulls", () => {
    const parsed = parseJob(jobs[2], SITE, "NORTURA SA")!
    const response = buildSearchResponse([parsed.result], 2, [{ employer: "X", error: "boom" }])
    expect(response.meta).toEqual({ count: 1, page: 2, errors: [{ employer: "X", error: "boom" }] })
    expect(Object.keys(response.results[0]).sort()).toEqual(["company", "date", "id", "location", "title", "url"])
    expect(response.results[0].location).toBeNull()
  })
})

describe("detail lookup", () => {
  const fetcher = async () => fixture("jobs.json")

  test("finds a job on a known career site and maps every detail field", async () => {
    const target = normalizeTarget(`${SITE}:${G2}`)!
    const matches = await findJob(target, [baseEmployer], fetcher)
    expect(matches).toHaveLength(1)
    expect(matches[0].company).toBe("NORTURA SA")

    const detail = toJobDetail(matches[0])!
    expect(detail.title).toBe("Utvikler")
    expect(detail.location).toBe("Trondheim")
    expect(detail.description).toContain("TypeScript")
    expect(detail.employmentType).toBe("Fast ansettelse")
    expect(detail.department).toBe("Teknologi, Digital")
    expect(detail.published).toBe("2026-11-01")
    expect(detail.endDate).toBe("2026-11-22")
    expect(detail.refNo).toBe("N-2026/86")
  })

  test("resolves a bare job GUID across registry sites", async () => {
    const target = normalizeTarget(G4)!
    const matches = await findJob(target, [baseEmployer], fetcher)
    expect(matches).toHaveLength(1)
    expect(matches[0].siteGuid).toBe(SITE)
  })

  test("reports ambiguity when a bare GUID exists on several sites", async () => {
    const other: Employer = {
      ...baseEmployer,
      name: "OTHER",
      atsRef: "https://hire.vismatalent.com/spa/nb/public/careers/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    }
    const matches = await findJob(normalizeTarget(G1)!, [baseEmployer, other], fetcher)
    expect(matches).toHaveLength(2)
  })

  test("returns no match for an unknown GUID", async () => {
    const matches = await findJob(normalizeTarget(`${SITE}:${MISSING}`)!, [baseEmployer], fetcher)
    expect(matches).toHaveLength(0)
  })
})
