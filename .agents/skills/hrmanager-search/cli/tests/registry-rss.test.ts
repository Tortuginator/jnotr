import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { FIXTURES_DIR } from "./server"
import {
  descriptionLocation,
  enabledEmployers,
  extractLocation,
  htmlToText,
  loadArea,
  locationMatches,
  mapRssItem,
  matchesQuery,
  normalizeText,
  paginate,
  parseDate,
  parseHrRef,
  parseRss,
  titleLocation,
  withinJobAge,
} from "../src/helpers"

const area = loadArea(join(FIXTURES_DIR, "area.json"))
const xml = readFileSync(join(FIXTURES_DIR, "Sparebank1.xml"), "utf8")

describe("registry refs", () => {
  test("filters to enabled hrmanager rows", () => {
    const employers = enabledEmployers("hrmanager", join(FIXTURES_DIR, "employers.csv"))
    expect(employers.map((e) => e.name)).toEqual([
      "SPAREBANK 1 SMN",
      "GK NORGE AS",
      "MUSEENE I SØR-TRØNDELAG AS",
      "SPAREBANK 1 REGNSKAPSHUSET SMN AS",
    ])
  })

  test("parses customer and cid forms", () => {
    expect(parseHrRef("customer=Sparebank1")).toEqual({ kind: "customer", value: "Sparebank1" })
    expect(parseHrRef("cid=139")).toEqual({ kind: "cid", value: "139" })
    expect(parseHrRef("https://candidate.hr-manager.net/vacancies/list.aspx?cid=1004")).toEqual({
      kind: "cid",
      value: "1004",
    })
    expect(parseHrRef("https://candidate.hr-manager.net/vacancies/list.aspx?customer=mist")).toEqual({
      kind: "customer",
      value: "mist",
    })
    expect(parseHrRef("not a ref!")).toBeNull()
  })
})

describe("RSS parsing", () => {
  const items = parseRss(xml)

  test("parses every item and decodes entities", () => {
    expect(items).toHaveLength(4)
    expect(items[0].guid).toBe("149231")
    expect(items[0].title).toBe("Autorisert privatøkonomisk rådgiver - Haugesund / Aksdal")
    expect(items[0].link).toContain("ProjectId=149231")
    expect(items[0].link).toContain("&DepartmentId=19320")
    expect(items[0].pubDate).toContain("Nov 2026")
  })

  test("maps required fields, company and date", () => {
    const mapped = mapRssItem(items[0], "SPAREBANK 1 SMN", area)
    expect(mapped.result.id).toBe("149231")
    expect(mapped.result.title).toContain("Autorisert")
    expect(mapped.result.company).toBe("SPAREBANK 1 SMN")
    expect(mapped.result.location).toBe("Haugesund / Aksdal")
    expect(mapped.result.date).toBe("2026-11-04")
    expect(mapped.result.url).toContain("ApplicationInit.aspx")
  })

  test("descriptions are decoded once and stripped to readable text", () => {
    const mapped = mapRssItem(items[2], "SPAREBANK 1 SMN", area)
    expect(mapped.descriptionText).toContain("På Heimdal søker vi")
    expect(mapped.descriptionText).not.toContain("&lt;")
    expect(htmlToText("<p>One</p><p>Two</p>")).toBe("One\nTwo")
  })
})

describe("location extraction", () => {
  test("reads a short trailing title segment", () => {
    expect(titleLocation("Finansrådgiver - Namsos")).toBe("Namsos")
    expect(titleLocation("Autorisert rådgiver - Haugesund / Aksdal")).toBe("Haugesund / Aksdal")
    expect(titleLocation("Fullstack-utvikler | Vil du utvikle deg?")).toBeNull()
    expect(titleLocation("Saksbehandler")).toBeNull()
  })

  test("description fallback requires a hiring/location verb", () => {
    expect(descriptionLocation("På Heimdal søker vi en saksbehandler.", area)).toBe("Heimdal")
    expect(descriptionLocation("Hovedkontoret vårt ligger i Trondheim.", area)).toBeNull()
    expect(extractLocation("Utvikler", "<p>På Heimdal søker vi.</p>", area)).toBe("Heimdal")
    // A title location wins over boilerplate in the description.
    expect(extractLocation("Finansrådgiver - Namsos", "<p>På Heimdal søker vi.</p>", area)).toBe("Namsos")
  })

  test("area matching uses the extracted location", () => {
    expect(locationMatches({ text: "Heimdal" }, "area", area)).toBe(true)
    expect(locationMatches({ text: "Namsos" }, "area", area)).toBe(false)
    expect(locationMatches({ text: null }, "area", area)).toBe(false)
    expect(locationMatches({ text: "Heimdal" }, "Trondheim", area)).toBe(true)
  })

  test("query matches title and description, case- and accent-insensitively", () => {
    const mapped = mapRssItem(parseRss(xml)[3], "SPAREBANK 1 SMN", area)
    expect(matchesQuery(mapped, "utvikler")).toBe(true)
    expect(matchesQuery(mapped, "JAVA")).toBe(true)
    expect(matchesQuery(mapped, "saksbehandler")).toBe(false)
    expect(normalizeText("Rådgiver")).toBe("radgiver")
  })
})

describe("dates and paging", () => {
  test("parses RFC and ISO dates", () => {
    expect(parseDate("Wed, 04 Nov 2026 14:12:42 +0100")).toBe("2026-11-04")
    expect(parseDate("2026-11-05T09:00:00+01:00")).toBe("2026-11-05")
    expect(parseDate("nope")).toBeNull()
  })

  test("job age is calendar-day based", () => {
    const now = Date.parse("2026-11-06T12:00:00Z")
    expect(withinJobAge("2026-11-05", 1, now)).toBe(true)
    expect(withinJobAge("2026-11-04", 1, now)).toBe(false)
    expect(withinJobAge(null, 1, now)).toBe(false)
  })

  test("paginate is 1-indexed and uses limit as page size", () => {
    expect(paginate([1, 2, 3, 4, 5], 1, 2)).toEqual([1, 2])
    expect(paginate([1, 2, 3, 4, 5], 3, 2)).toEqual([5])
  })
})
