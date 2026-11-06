import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  matchesArea,
  matchesPlace,
  normalizeLocation,
  type AreaFile,
  type RawLocation,
} from "../src/helpers"
import { FIXTURES } from "./helpers"

const area = JSON.parse(readFileSync(join(FIXTURES, "area.json"), "utf8")) as AreaFile

function location(overrides: Partial<RawLocation> = {}): RawLocation {
  return { name: null, address: null, zip: null, city: null, country: "Norway", ...overrides }
}

describe("normalizeLocation", () => {
  test("is case- and diacritic-insensitive", () => {
    expect(normalizeLocation("Stjørdal")).toBe(normalizeLocation("STJORDAL"))
    expect(normalizeLocation("  Byåsen ")).toBe("byasen")
    expect(normalizeLocation("Bodø")).toBe("bodo")
  })
})

describe("area matching", () => {
  test("matches the municipality name", () => {
    expect(matchesArea([location({ name: "Trondheim", city: "Trondheim" })], area)).toBe(true)
  })

  test("matches a place inside Trondheim (Heimdal)", () => {
    expect(matchesArea([location({ name: "Trondheim", city: "Heimdal" })], area)).toBe(true)
  })

  test("matches a Trondheim postal prefix", () => {
    expect(matchesArea([location({ name: "Unknown", city: "Unknown", zip: "7072" })], area)).toBe(true)
  })

  test("matches another commute municipality", () => {
    expect(matchesArea([location({ name: "Malvik", city: "Hommelvik" })], area)).toBe(true)
    expect(matchesArea([location({ name: "Stjørdal", city: "Hell" })], area)).toBe(true)
  })

  test("matches a diacritic-free alias", () => {
    expect(matchesArea([location({ name: "STJORDAL", city: "Stjordal" })], area)).toBe(true)
  })

  test("rejects places outside the area", () => {
    expect(matchesArea([location({ name: "Oslo", city: "Oslo", zip: "0150" })], area)).toBe(false)
    expect(matchesArea([], area)).toBe(false)
  })

  test("does not treat a foreign place with the same name as the Trondheim place", () => {
    expect(matchesArea([location({ name: "Lund", city: "Lund", country: "Sweden" })], area)).toBe(false)
    expect(matchesArea([location({ name: "Lund", city: "Lund", country: "Norway" })], area)).toBe(true)
  })

  test("allows a missing country when the name or postal prefix matches", () => {
    expect(matchesArea([location({ name: "Trondheim", country: null })], area)).toBe(true)
  })
})

describe("specific place matching", () => {
  test("matches location name", () => {
    expect(matchesPlace([location({ name: "Trondheim", city: "Heimdal" })], "Trondheim")).toBe(true)
  })

  test("matches location city", () => {
    expect(matchesPlace([location({ name: "Trondheim", city: "Heimdal" })], "Heimdal")).toBe(true)
  })

  test("is case- and diacritic-insensitive", () => {
    expect(matchesPlace([location({ name: "Stjørdal" })], "stjordal")).toBe(true)
  })

  test("rejects a different place", () => {
    expect(matchesPlace([location({ name: "Trondheim", city: "Heimdal" })], "Oslo")).toBe(false)
  })
})
