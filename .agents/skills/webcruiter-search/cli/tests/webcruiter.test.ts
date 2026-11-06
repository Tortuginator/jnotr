import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  filterEmployers,
  fold,
  isWithinDays,
  loadArea,
  locationMatches,
  parseCsv,
  type Employer,
} from "../src/helpers"
import {
  buildSearchBody,
  collectResults,
  parseWebcruiterItem,
  resolveTenant,
  type WebcruiterAdvert,
} from "../src/commands/search"
import { normalizeTarget, parseWebcruiterDetail } from "../src/commands/detail"

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8")

const baseEmployer: Employer = {
  orgnr: "942110464",
  name: "TRONDHEIM KOMMUNE",
  aliases: "",
  website: "www.trondheim.kommune.no",
  careerUrl: "",
  ats: "webcruiter",
  atsRef: "companylock=7254",
  confidence: "high",
  enabled: true,
}

describe("registry", () => {
  test("parseCsv handles quoted fields and escaped quotes", () => {
    expect(parseCsv('a,b\n"x,y","he said ""hi"""\n')).toEqual([
      ["a", "b"],
      ["x,y", 'he said "hi"'],
    ])
  })

  test("filterEmployers keeps only enabled rows for the ATS", () => {
    const rows: Employer[] = [
      baseEmployer,
      { ...baseEmployer, name: "DISABLED", enabled: false },
      { ...baseEmployer, name: "OTHER", ats: "reachmee" },
    ]
    expect(filterEmployers(rows, "webcruiter").map((row) => row.name)).toEqual(["TRONDHEIM KOMMUNE"])
  })
})

describe("Webcruiter refs and request body", () => {
  test("resolveTenant accepts every registry ats_ref shape", () => {
    expect(resolveTenant("companylock=7254")).toBe("7254")
    expect(resolveTenant("https://960040.webcruiter.no")).toBe("960040")
    expect(resolveTenant("https://23151000.webcruiter.no/Main/Recruit/Public/1")).toBe("23151000")
    expect(resolveTenant("https://candidate.webcruiter.com/nb-no/Home/companyadverts?companylock=748307")).toBe(
      "748307",
    )
    expect(resolveTenant("")).toBeNull()
  })

  test("buildSearchBody matches the verified POST body and pages by skip", () => {
    expect(buildSearchBody(1, 3)).toBe('{"take":3,"skip":0,"page":1,"pageSize":3}')
    expect(buildSearchBody(2, 3)).toBe('{"take":3,"skip":3,"page":2,"pageSize":3}')
  })
})

describe("Webcruiter field mapping", () => {
  const response = JSON.parse(fixture("companysearch.json")) as { Data: WebcruiterAdvert[] }

  test("maps the verified advert fields and dates", () => {
    const parsed = parseWebcruiterItem(response.Data[0], "7254", "TRONDHEIM KOMMUNE")
    expect(parsed).not.toBeNull()
    expect(parsed!.result).toEqual({
      id: "7254:5198357738",
      title: "Barnehagelærer",
      company: "TRONDHEIM KOMMUNE",
      location: "Ranheim",
      date: "2026-10-27",
      url: "https://7254.webcruiter.no/Main/Recruit/Public/5198357738?language=en&link_source_id=0",
    })
    expect(fold(parsed!.queryText)).toContain("barnehagelaerer")
    expect(parsed!.queryText).not.toContain("ignoreMe")
  })

  test("falls back to the tenant URL and keeps null-ish fields present", () => {
    const parsed = parseWebcruiterItem(response.Data[1], "7254", "TRONDHEIM KOMMUNE")!
    expect(parsed.result.url).toBe("https://7254.webcruiter.no/Main/Recruit/Public/5197874504")
    expect(parsed.result.location).toBe("Byåsen")
    expect(parsed.result.date).toBe("2026-10-29")
    expect(Object.keys(parsed.result).sort()).toEqual(["company", "date", "id", "location", "title", "url"])
  })

  test("company falls back to the advert when the registry name is empty", () => {
    const parsed = parseWebcruiterItem(response.Data[1], "7254", "")!
    expect(parsed.result.company).toBe("Trondheim kommune")
  })
})

describe("location and query filters", () => {
  const area = loadArea()!

  test("area matches municipalities, places and postal prefixes", () => {
    expect(locationMatches("Ranheim", "area", area)).toBe(true)
    expect(locationMatches("Hundhammeren", "area", area)).toBe(true)
    expect(locationMatches("Stjørdal", "area", area)).toBe(true)
    expect(locationMatches("7050", "area", area)).toBe(true)
    expect(locationMatches("Stockholm", "area", area)).toBe(false)
    expect(locationMatches("", "area", area)).toBe(false)
  })

  test("a municipality name also matches its places", () => {
    expect(locationMatches("Ranheim", "Trondheim", area)).toBe(true)
    expect(locationMatches("Ranheim", "Stjørdal", area)).toBe(false)
    expect(locationMatches("Stjørdal", "trondheim", area)).toBe(false)
  })

  test("diacritics fold for matching", () => {
    expect(fold("STJØRDAL")).toBe("stjordal")
    expect(fold("Byåsen")).toBe("byasen")
  })
})

describe("job age", () => {
  test("uses the posting date and the current UTC day", () => {
    const now = new Date("2026-11-06T12:00:00Z")
    expect(isWithinDays("2026-10-27", 14, now)).toBe(true)
    expect(isWithinDays("2026-10-27", 5, now)).toBe(false)
    expect(isWithinDays("2026-11-06", 0, now)).toBe(true)
  })
})

describe("collectResults", () => {
  const response = fixture("companysearch.json")
  const deps = {
    area: loadArea(),
    employers: [
      baseEmployer,
      { ...baseEmployer, name: "BROKEN", atsRef: "" },
    ],
    fetchText: async (url: string) => {
      if (url.includes("/7254?")) return response
      throw new Error(`unexpected fetch ${url}`)
    },
  }

  test("pools employers, normalises company and records per-employer errors", async () => {
    const { results, errors } = await collectResults({ page: 1, jobage: 3650, format: "json" }, deps)
    expect(results).toHaveLength(2)
    expect(errors).toHaveLength(1)
    expect(errors[0].employer).toBe("BROKEN")
    expect(errors[0].error).toContain("no Webcruiter tenant")
    expect(results.every((result) => result.company === "TRONDHEIM KOMMUNE")).toBe(true)
  })

  test("applies query, area and jobage filters client-side", async () => {
    const query = await collectResults({ page: 1, query: "helsefagarbeider", format: "json" }, deps)
    expect(query.results.map((result) => result.title)).toEqual(["Helsefagarbeider"])

    const area = await collectResults({ page: 1, location: "area", format: "json" }, deps)
    expect(area.results).toHaveLength(2)

    const outside = await collectResults({ page: 1, location: "Stjørdal", format: "json" }, deps)
    expect(outside.results).toHaveLength(0)
  })
})

describe("detail", () => {
  const target = normalizeTarget("7254:5198357738")!

  test("normalises tenant:id and posting URLs, rejects bare ids and other hosts", () => {
    expect(target.url).toBe("https://7254.webcruiter.no/Main/Recruit/Public/5198357738")
    expect(
      normalizeTarget("https://7254.webcruiter.no/Main/Recruit/Public/5198357738?language=en&link_source_id=0"),
    ).toMatchObject({ tenant: "7254", advertId: "5198357738" })
    expect(normalizeTarget("5198357738")).toBeNull()
    expect(normalizeTarget("https://evil.example/Main/Recruit/Public/5198357738")).toBeNull()
  })

  test("parses title, key info and every visible description block", () => {
    const job = parseWebcruiterDetail(fixture("detail.html"), target)
    expect(job.title).toBe("Barnehagelærer")
    expect(job.company).toBe("Trondheim kommune")
    expect(job.location).toBe("Ranheim")
    expect(job.deadline).toBe("09.11.2026")
    expect(job.employmentType).toBe("Fast")
    expect(job.description).toContain("Planlegge og gjennomføre pedagogisk arbeid")
    expect(job.description).toContain("Samarbeide med foreldre")
    expect(job.description).not.toContain("Hidden instruction")
    expect(job.description).not.toContain("doNotShow")
  })
})
