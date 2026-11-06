import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import {
  AREA_FIXTURE,
  EMPLOYERS_FIXTURE,
  baseRecord,
  cleanup,
  daysAgoDate,
  daysAgoTimestamp,
  makeCacheStale,
  parseJSON,
  runCLI,
  tempDir,
  writeCache,
} from "./helpers.js"
import type { NormRecord } from "../src/helpers.js"

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) cleanup(dir)
})

function tmp(): string {
  const dir = tempDir()
  dirs.push(dir)
  return dir
}

const A = "11111111-1111-4111-8111-111111111111"
const B = "22222222-2222-4222-8222-222222222222"
const C = "33333333-3333-4333-8333-333333333333"
const D = "44444444-4444-4444-8444-444444444444"
const E = "55555555-5555-4555-8555-555555555555"
const F = "66666666-6666-4666-8666-666666666666"
const G = "77777777-7777-4777-8777-777777777777"

function records(): NormRecord[] {
  const today = daysAgoDate(0)
  const todayStamp = daysAgoTimestamp(0)
  const old = daysAgoDate(10)
  const oldStamp = daysAgoTimestamp(10)
  return [
    baseRecord({ uuid: A, id: A, title: "Utvikler", description: "Backend og frontend", date: today, date_modified: todayStamp }),
    baseRecord({ uuid: B, id: B, title: "Ingeniør", description: null, municipal: "MALVIK", location: "Malvik", city: "HOM MELVIK", postal_code: "7500", date: today, date_modified: todayStamp }),
    baseRecord({ uuid: C, id: C, title: "Utvikler", description: null, municipal: "OSLO", location: "Oslo", city: "OSLO", postal_code: "0150", date: today, date_modified: todayStamp }),
    baseRecord({ uuid: D, id: D, title: "Utvikler gammel", description: null, status: "INACTIVE", date: today, date_modified: todayStamp }),
    baseRecord({ uuid: E, id: E, title: "Renholder", description: null, municipal: null, location: "Trondheim", city: "TRONDHEIM", postal_code: "7030", date: today, date_modified: todayStamp }),
    baseRecord({ uuid: F, id: F, title: "Butikkmedarbeider", description: null, municipal: "STJØRDAL", location: "Stjørdal", city: "STJØRDAL", postal_code: "7500", date: old, date_modified: oldStamp }),
    baseRecord({ uuid: G, id: G, title: "Utvikler", description: null, date: old, date_modified: oldStamp }),
  ]
}

async function search(args: string[], extraEnv: Record<string, string | undefined> = {}) {
  const dir = tmp()
  const cache = join(dir, "nav_cache.jsonl")
  writeCache(cache, records())
  return runCLI(["search", ...args], {
    NAV_CACHE_PATH: cache,
    NAV_STATE_PATH: join(dir, "state.json"),
    NAV_AREA_PATH: AREA_FIXTURE,
    NAV_EMPLOYERS_PATH: EMPLOYERS_FIXTURE,
    NAV_API_TOKEN: undefined,
    ...extraEnv,
  })
}

function ids(body: { results: Array<{ id: string }> }): string[] {
  return body.results.map((result) => result.id).sort()
}

describe("search filters", () => {
  test("only ACTIVE records are returned", async () => {
    const result = await search(["-q", "utvikler"])
    expect(result.exitCode).toBe(0)
    const body = parseJSON<{ meta: { count: number }; results: Array<{ id: string }> }>(result)
    expect(body.meta.count).toBe(3)
    expect(ids(body)).toEqual([A, C, G].sort())
    expect(ids(body)).not.toContain(D)
  })

  test("query matching is case-insensitive across title and description", async () => {
    const result = await search(["-q", "BACKEND"])
    const body = parseJSON<{ meta: { count: number }; results: Array<{ id: string }> }>(result)
    expect(body.meta.count).toBe(1)
    expect(body.results[0].id).toBe(A)
  })

  test("--location area matches the configured municipalities and postal prefixes", async () => {
    const result = await search(["-l", "area"])
    const body = parseJSON<{ meta: { count: number }; results: Array<{ id: string }> }>(result)
    expect(body.meta.count).toBe(5)
    expect(ids(body)).toEqual([A, B, E, F, G].sort())
    expect(ids(body)).not.toContain(C)
  })

  test("a municipality name matches that name case-insensitively", async () => {
    const result = await search(["-l", "trondheim"])
    const body = parseJSON<{ meta: { count: number }; results: Array<{ id: string }> }>(result)
    expect(body.meta.count).toBe(3)
    expect(ids(body)).toEqual([A, E, G].sort())
  })

  test("query and area combine", async () => {
    const result = await search(["-q", "utvikler", "-l", "area"])
    const body = parseJSON<{ meta: { count: number }; results: Array<{ id: string }> }>(result)
    expect(body.meta.count).toBe(2)
    expect(ids(body)).toEqual([A, G].sort())
  })

  test("--jobage filters on the ad date", async () => {
    const result = await search(["--jobage", "2"])
    const body = parseJSON<{ meta: { count: number }; results: Array<{ id: string }> }>(result)
    expect(body.meta.count).toBe(4)
    expect(ids(body)).toEqual([A, B, C, E].sort())

    const areaOnly = await search(["-l", "area", "--jobage", "2"])
    const areaBody = parseJSON<{ meta: { count: number }; results: Array<{ id: string }> }>(areaOnly)
    expect(areaBody.meta.count).toBe(3)
    expect(ids(areaBody)).toEqual([A, B, E].sort())
  })

  test("--page and --limit paginate client-side", async () => {
    const result = await search(["--limit", "2", "--page", "2"])
    const body = parseJSON<{ meta: { count: number; page: number } }>(result)
    expect(body.meta.page).toBe(2)
    expect(body.meta.count).toBe(2)
  })

  test("falls back to the five default municipalities when area.json is missing", async () => {
    const dir = tmp()
    const missingArea = join(dir, "does-not-exist.json")
    const result = await search(["-l", "area"], { NAV_AREA_PATH: missingArea })
    const body = parseJSON<{ meta: { count: number }; results: Array<{ id: string }> }>(result)
    expect(body.meta.count).toBe(5)
    expect(ids(body)).toEqual([A, B, E, F, G].sort())
  })
})

describe("search cache lifecycle", () => {
  test("a stale cache without a token is used with a non-fatal warning", async () => {
    const dir = tmp()
    const cache = join(dir, "nav_cache.jsonl")
    writeCache(cache, records())
    makeCacheStale(cache)
    const result = await runCLI(["search"], {
      NAV_CACHE_PATH: cache,
      NAV_STATE_PATH: join(dir, "state.json"),
      NAV_AREA_PATH: AREA_FIXTURE,
      NAV_EMPLOYERS_PATH: EMPLOYERS_FIXTURE,
      NAV_API_TOKEN: undefined,
    })
    expect(result.exitCode).toBe(0)
    const body = parseJSON<{ meta: { warning?: string; count: number } }>(result)
    expect(body.meta.warning).toBeTruthy()
    expect(body.meta.warning).toContain("stale cache")
    expect(body.meta.count).toBeGreaterThan(0)
  })

  test("a fresh cache without a token has no warning", async () => {
    const result = await search([])
    const body = parseJSON<{ meta: { warning?: string } }>(result)
    expect(body.meta.warning).toBeUndefined()
  })
})
