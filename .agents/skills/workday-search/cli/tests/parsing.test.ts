import { describe, expect, test } from "bun:test"
import {
  buildLocationCandidates,
  buildSearchBody,
  descriptorMatches,
  detailMatchesLocation,
  findLocationFacetIds,
  findLocationFacets,
  htmlToText,
  isAmbiguousLocationText,
  parsePostedOn,
  parseWorkdayRef,
  stripInvisible,
  visibleHtml,
} from "../src/helpers"

const NOW = new Date("2026-11-06T12:00:00Z")

const area = {
  municipalities: [
    {
      name: "Trondheim",
      aliases: ["TRONDHEIM", "Trondheim kommune"],
      places: ["Heimdal", "Rotvoll", "Lund"],
      postal_prefixes: ["70"],
    },
    {
      name: "Stjørdal",
      aliases: ["STJORDAL"],
      places: ["Hell"],
      postal_prefixes: ["75"],
    },
  ],
}

describe("parseWorkdayRef", () => {
  test("parses origin, tenant and site", () => {
    expect(parseWorkdayRef("https://norconsult.wd3.myworkdayjobs.com/Norconsult_Career_Site")).toEqual({
      origin: "https://norconsult.wd3.myworkdayjobs.com",
      host: "norconsult.wd3.myworkdayjobs.com",
      tenant: "norconsult",
      site: "Norconsult_Career_Site",
      ref: "https://norconsult.wd3.myworkdayjobs.com/Norconsult_Career_Site",
    })
  })

  test("skips a locale segment before the site", () => {
    const site = parseWorkdayRef(
      "https://norgesgruppen.wd3.myworkdayjobs.com/no-NO/karriere/job/Meny-Farmandstredet/example_JR100",
    )
    expect(site?.tenant).toBe("norgesgruppen")
    expect(site?.site).toBe("karriere")
  })

  test("accepts a trailing slash and a wd502 host", () => {
    const site = parseWorkdayRef("https://if.wd502.myworkdayjobs.com/Careers/")
    expect(site?.tenant).toBe("if")
    expect(site?.site).toBe("Careers")
  })

  test("rejects non-Workday refs and empty refs", () => {
    expect(parseWorkdayRef("https://hent.teamtailor.com/jobs.rss")).toBeNull()
    expect(parseWorkdayRef("")).toBeNull()
    expect(parseWorkdayRef("https://equinor.wd3.myworkdayjobs.com/")).toBeNull()
  })
})

describe("buildSearchBody", () => {
  test("uses Workday defaults", () => {
    expect(buildSearchBody({})).toEqual({
      appliedFacets: {},
      limit: 20,
      offset: 0,
      searchText: "",
    })
  })

  test("maps page/limit to offset/limit and clamps the page size", () => {
    expect(buildSearchBody({ limit: 10, offset: 20, searchText: "data" })).toEqual({
      appliedFacets: {},
      limit: 10,
      offset: 20,
      searchText: "data",
    })
    expect(buildSearchBody({ limit: 500 }).limit).toBe(100)
    expect(buildSearchBody({ limit: 0 }).limit).toBe(1)
    expect(buildSearchBody({ offset: -5 }).offset).toBe(0)
  })

  test("keeps applied facets", () => {
    const body = buildSearchBody({ appliedFacets: { locations: ["abc"] } })
    expect(body.appliedFacets).toEqual({ locations: ["abc"] })
  })
})

describe("parsePostedOn", () => {
  test("parses Workday's relative labels", () => {
    expect(parsePostedOn("Posted Today", NOW)).toBe("2026-11-06")
    expect(parsePostedOn("Posted Yesterday", NOW)).toBe("2026-11-05")
    expect(parsePostedOn("Posted 2 Days Ago", NOW)).toBe("2026-11-04")
    expect(parsePostedOn("Posted 30+ Days Ago", NOW)).toBe("2026-10-07")
    expect(parsePostedOn("Posted 2 Months Ago", NOW)).toBe("2026-09-07")
  })

  test("passes through an ISO date and rejects an unknown label", () => {
    expect(parsePostedOn("2026-10-23", NOW)).toBe("2026-10-23")
    expect(parsePostedOn("Posted soon", NOW)).toBeNull()
    expect(parsePostedOn(null, NOW)).toBeNull()
  })
})

describe("location matching", () => {
  const areaCandidates = buildLocationCandidates("area", area)

  test("area includes municipality names, aliases and places", () => {
    expect(areaCandidates.has("trondheim")).toBe(true)
    expect(areaCandidates.has("heimdal")).toBe(true)
    expect(areaCandidates.has("rotvoll")).toBe(true)
    expect(areaCandidates.has("stjordal")).toBe(true)
    expect(areaCandidates.has("oslo")).toBe(false)
  })

  test("specific place expands to its municipality", () => {
    const candidates = buildLocationCandidates("Heimdal", area)
    expect(candidates.has("heimdal")).toBe(true)
    expect(candidates.has("trondheim")).toBe(true)
    expect(candidates.has("stjordal")).toBe(false)
  })

  test("descriptor matching is case- and diacritic-tolerant and strips country", () => {
    expect(descriptorMatches("Stjørdal, Norway", areaCandidates)).toBe(true)
    expect(descriptorMatches("Rotvoll, Norway", areaCandidates)).toBe(true)
    expect(descriptorMatches("TRONDHEIM", areaCandidates)).toBe(true)
    expect(descriptorMatches("ASKO Midt-Norge, Trondheim", areaCandidates)).toBe(true)
    expect(descriptorMatches("Oslo, Norway", areaCandidates)).toBe(false)
  })

  test("finds nested locations facet ids", () => {
    const facets = [
      {
        facetParameter: "locationMainGroup",
        values: [
          {
            facetParameter: "locations",
            descriptor: "Locations",
            values: [
              { descriptor: "Rotvoll, Norway", id: "rotvoll-id", count: 1 },
              { descriptor: "Stjørdal, Norway", id: "stjordal-id", count: 3 },
              { descriptor: "Oslo, Norway", id: "oslo-id", count: 2 },
            ],
          },
        ],
      },
    ]
    expect(findLocationFacetIds(facets, areaCandidates).sort()).toEqual(["rotvoll-id", "stjordal-id"])
  })

  test("finds a top-level locations facet", () => {
    const facets = [{ facetParameter: "locations", values: [{ descriptor: "Trondheim", id: "t-id" }] }]
    expect(findLocationFacetIds(facets, areaCandidates)).toEqual(["t-id"])
  })

  test("keeps the facet parameter as the appliedFacets key", () => {
    const facets = [
      {
        facetParameter: "locationMainGroup",
        values: [
          {
            facetParameter: "locationHierarchy1",
            descriptor: "Municipality",
            values: [
              { descriptor: "Trondheim", id: "trondheim-id" },
              { descriptor: "Oslo", id: "oslo-id" },
            ],
          },
        ],
      },
    ]
    expect(findLocationFacets(facets, areaCandidates)).toEqual({ locationHierarchy1: ["trondheim-id"] })
  })

  test("recognises ambiguous labels", () => {
    expect(isAmbiguousLocationText("4 Locations")).toBe(true)
    expect(isAmbiguousLocationText("Multiple Locations")).toBe(true)
    expect(isAmbiguousLocationText("Nordic")).toBe(true)
    expect(isAmbiguousLocationText("Trondheim")).toBe(false)
  })

  test("checks detail location and additional locations", () => {
    expect(
      detailMatchesLocation(
        { location: "Nordic", additionalLocations: ["Turku", "Trondheim"] },
        areaCandidates,
      ),
    ).toBe(true)
    expect(
      detailMatchesLocation(
        { location: "Nordic", additionalLocations: ["Turku", "Espoo", "København"] },
        areaCandidates,
      ),
    ).toBe(false)
  })
})

describe("output hygiene", () => {
  test("visibleHtml removes comments, hidden elements and scripts", () => {
    const html =
      "<p>Visible</p><!-- secret --><div style='display:none'>hidden instruction</div><script>bad()</script><p>Tail</p>"
    const text = htmlToText(html)
    expect(text).toBe("Visible\nTail")
  })

  test("stripInvisible removes zero-width and bidi characters", () => {
    expect(stripInvisible({ title: "Soft\u200bware\u202e" })).toEqual({ title: "Software" })
  })
})
