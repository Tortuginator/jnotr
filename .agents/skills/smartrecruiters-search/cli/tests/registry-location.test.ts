import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { FIXTURES_DIR } from "./server"
import {
  enabledEmployers,
  loadArea,
  locationMatches,
  normalizeText,
  paginate,
  parseDate,
  parseRegistryCsv,
  parseSlug,
  resolveSlug,
  withinJobAge,
} from "../src/helpers"

describe("registry", () => {
  test("filters to enabled rows with the requested ATS", () => {
    const employers = enabledEmployers("smartrecruiters", join(FIXTURES_DIR, "employers.csv"))
    expect(employers.map((e) => e.name)).toEqual([
      "SOPRA STERIA AS",
      "RAMBØLL NORGE AS",
      "SPORTRADAR AS",
      "AKER SOLUTIONS AS",
    ])
  })

  test("parses quoted CSV cells and aliases", () => {
    const rows = parseRegistryCsv(
      [
        "orgnr,name,aliases,trd_staff,nace,website,career_url,ats,ats_ref,confidence,enabled,status",
        '1,"A, B",One|Two,10,62.2,,,smartrecruiters,slug,high,true,',
      ].join("\n"),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe("A, B")
    expect(rows[0].aliases).toEqual(["One", "Two"])
    expect(rows[0].enabled).toBe(true)
  })

  test("accepts slug forms and rejects API versions", () => {
    expect(parseSlug("SopraSteria1")).toBe("SopraSteria1")
    expect(parseSlug("https://api.smartrecruiters.com/v1/companies/Ramboll3/postings")).toBe("Ramboll3")
    expect(parseSlug("slug=Sportradar")).toBe("Sportradar")
    expect(parseSlug("not a slug!")).toBeNull()

    const sports = enabledEmployers("smartrecruiters", join(FIXTURES_DIR, "employers.csv")).find(
      (e) => e.name === "SPORTRADAR AS",
    )!
    expect(resolveSlug(sports)).toBe("Sportradar")

    const aker = enabledEmployers("smartrecruiters", join(FIXTURES_DIR, "employers.csv")).find(
      (e) => e.name === "AKER SOLUTIONS AS",
    )!
    expect(() => resolveSlug(aker)).toThrow(/API version/)
  })
})

describe("location matching", () => {
  const area = loadArea(join(FIXTURES_DIR, "area.json"))

  test("normalizes Norwegian characters and punctuation", () => {
    expect(normalizeText("Trondheim, Trøndelag")).toBe("trondheim trondelag")
    expect(normalizeText("Børsa / Skaun")).toBe("borsa skaun")
  })

  test("area matches municipalities, places and postal prefixes", () => {
    expect(locationMatches({ text: "Trondheim, Trøndelag, Norway" }, "area", area)).toBe(true)
    expect(locationMatches({ text: "Heimdal, Trøndelag, Norway" }, "area", area)).toBe(true)
    expect(locationMatches({ text: null, postalCode: "7500" }, "area", area)).toBe(true)
    expect(locationMatches({ text: "Oslo, Norway" }, "area", area)).toBe(false)
    expect(locationMatches({ text: "Toulouse, France" }, "area", area)).toBe(false)
  })

  test("specific places match their municipality and places", () => {
    expect(locationMatches({ text: "Trondheim, Trøndelag, Norway" }, "Trondheim", area)).toBe(true)
    expect(locationMatches({ text: "Heimdal, Trøndelag, Norway" }, "Trondheim", area)).toBe(true)
    expect(locationMatches({ text: "Hommelvik, Norway" }, "Malvik", area)).toBe(true)
    expect(locationMatches({ text: "Lundamo, Norway" }, "Melhus", area)).toBe(true)
    expect(locationMatches({ text: "Oslo, Norway" }, "Trondheim", area)).toBe(false)
    expect(locationMatches({ text: "Oslo, Norway" }, "Oslo", area)).toBe(true)
  })

  test("no location filter keeps everything", () => {
    expect(locationMatches({ text: "Anywhere" }, undefined, area)).toBe(true)
  })
})

describe("dates and paging", () => {
  test("parses ISO and RFC dates to YYYY-MM-DD", () => {
    expect(parseDate("2026-11-06T12:54:41.870Z")).toBe("2026-11-06")
    expect(parseDate("Wed, 04 Nov 2026 14:12:42 +0100")).toBe("2026-11-04")
    expect(parseDate("not a date")).toBeNull()
    expect(parseDate(null)).toBeNull()
  })

  test("job age is calendar-day based and drops unknown dates", () => {
    const now = Date.parse("2026-11-06T12:00:00Z")
    expect(withinJobAge("2026-11-06", 1, now)).toBe(true)
    expect(withinJobAge("2026-11-05", 1, now)).toBe(true)
    expect(withinJobAge("2026-11-04", 1, now)).toBe(false)
    expect(withinJobAge(null, 1, now)).toBe(false)
    expect(withinJobAge(null, undefined, now)).toBe(true)
  })

  test("paginate is 1-indexed and uses limit as page size", () => {
    expect(paginate([1, 2, 3, 4, 5], 1, 2)).toEqual([1, 2])
    expect(paginate([1, 2, 3, 4, 5], 3, 2)).toEqual([5])
    expect(paginate([1, 2, 3], 2, undefined)).toEqual([])
  })
})
