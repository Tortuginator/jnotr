import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  AREA_FIXTURE,
  DETAIL_ACTIVE,
  EMPLOYERS_FIXTURE,
  FEED_LAST,
  FEED_PAGE_1,
  FEED_PAGE_2,
  baseRecord,
  cleanup,
  parseJSON,
  runCLI,
  tempDir,
} from "./helpers.js"

const dirs: string[] = []
const servers: Array<{ stop: () => void }> = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop()
  for (const dir of dirs.splice(0)) cleanup(dir)
})

function tmp(): string {
  const dir = tempDir()
  dirs.push(dir)
  return dir
}

function fixture(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"))
}

describe("sync", () => {
  test("parses a fixture feed, upserts records and writes cache + state", async () => {
    const dir = tmp()
    const cache = join(dir, "nav_cache.jsonl")
    const state = join(dir, "nav_feed_state.json")
    const queryServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/api/v1/feed" && url.searchParams.has("last")) {
          return Response.json(fixture(FEED_LAST))
        }
        if (url.pathname === "/api/v1/feed") return Response.json(fixture(FEED_PAGE_1))
        if (url.pathname === "/api/v1/feedentry/11111111-1111-4111-8111-111111111111") {
          return Response.json(fixture(DETAIL_ACTIVE))
        }
        if (url.pathname === "/api/v1/feed/fixture-page-2") return Response.json(fixture(FEED_PAGE_2))
        return new Response(JSON.stringify({ status: 404 }), { status: 404 })
      },
    })
    servers.push({ stop: () => queryServer.stop(true) })

    const result = await runCLI(["sync", "--since", "3650", "--max-pages", "2", "--details-limit", "7"], {
      NAV_API_TOKEN: "fixture-token",
      NAV_FEED_BASE_URL: queryServer.url.origin,
      NAV_CACHE_PATH: cache,
      NAV_STATE_PATH: state,
      NAV_AREA_PATH: AREA_FIXTURE,
      NAV_EMPLOYERS_PATH: EMPLOYERS_FIXTURE,
    })
    expect(result.exitCode).toBe(0)
    const summary = parseJSON<{ meta: { pages: number; items: number; cache_size: number; active: number } }>(result)
    expect(summary.meta.pages).toBe(2)
    expect(summary.meta.cache_size).toBe(7)
    expect(summary.meta.active).toBe(6)
    expect(summary.meta.details_fetched).toBe(1)

    expect(existsSync(cache)).toBe(true)
    expect(existsSync(state)).toBe(true)
    const records = readFileSync(cache, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    const byUuid = new Map(records.map((record) => [record.uuid, record]))
    expect(byUuid.get("11111111-1111-4111-8111-111111111111").status).toBe("ACTIVE")
    expect([...byUuid.values()].some((record) => String(record.description ?? "").includes("TypeScript"))).toBe(true)
    expect(byUuid.get("44444444-4444-4444-8444-444444444444").status).toBe("INACTIVE")
    expect(byUuid.get("66666666-6666-4666-8666-666666666666").municipal).toBe("STJØRDAL")
    expect(byUuid.get("77777777-7777-4777-8777-777777777777").title).toBe("Ny stilling")

    const savedState = JSON.parse(readFileSync(state, "utf8"))
    expect(savedState.last_item_date).toBeTruthy()
    expect(savedState.seen_page_ids).toContain("fixture-page-1")
    expect(savedState.seen_page_ids).toContain("fixture-page-2")
    expect(savedState.seen_page_ids).toContain("fixture-last-page")

    const search = await runCLI(["search", "-q", "utvikler", "-l", "area", "--limit", "10"], {
      NAV_CACHE_PATH: cache,
      NAV_STATE_PATH: state,
      NAV_AREA_PATH: AREA_FIXTURE,
      NAV_EMPLOYERS_PATH: EMPLOYERS_FIXTURE,
      NAV_API_TOKEN: undefined,
    })
    expect(search.exitCode).toBe(0)
    const body = parseJSON<{ meta: { count: number }; results: Array<Record<string, unknown>> }>(search)
    expect(body.meta.count).toBe(1)
    expect(body.results[0].id).toBe("11111111-1111-4111-8111-111111111111")
    expect(body.results[0].company).toBe("TRONDHEIM KOMMUNE")
    expect(body.results[0].date).toBe("2026-11-05")
    expect(body.results[0].url).toContain("11111111-1111-4111-8111-111111111111")
  })

  test("never resurrects an ACTIVE record older than a cached INACTIVE state", async () => {
    const dir = tmp()
    const cache = join(dir, "nav_cache.jsonl")
    const state = join(dir, "nav_feed_state.json")
    const freshInactive = baseRecord({
      status: "INACTIVE",
      date_modified: "2026-11-06T12:00:00+01:00",
      title: "Utvikler",
    })
    writeFileSync(cache, JSON.stringify(freshInactive) + "\n")
    writeFileSync(state, JSON.stringify({ version: 1, last_sync: null, last_item_date: null, newest_item_date: null, last_page_id: null, seen_page_ids: [] }))

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/api/v1/feed" && url.searchParams.has("last")) {
          return Response.json(fixture(FEED_LAST))
        }
        if (url.pathname === "/api/v1/feed") return Response.json(fixture(FEED_PAGE_1))
        if (url.pathname === "/api/v1/feedentry/11111111-1111-4111-8111-111111111111") {
          return Response.json(fixture(DETAIL_ACTIVE))
        }
        if (url.pathname === "/api/v1/feed/fixture-page-2") return Response.json(fixture(FEED_PAGE_2))
        return new Response(JSON.stringify({ status: 404 }), { status: 404 })
      },
    })
    servers.push({ stop: () => server.stop(true) })

    const result = await runCLI(["sync", "--since", "3650", "--max-pages", "2", "--details-limit", "7"], {
      NAV_API_TOKEN: "fixture-token",
      NAV_FEED_BASE_URL: server.url.origin,
      NAV_CACHE_PATH: cache,
      NAV_STATE_PATH: state,
      NAV_AREA_PATH: AREA_FIXTURE,
      NAV_EMPLOYERS_PATH: EMPLOYERS_FIXTURE,
    })
    expect(result.exitCode).toBe(0)
    const records = readFileSync(cache, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    const record = records.find((entry) => entry.uuid === "11111111-1111-4111-8111-111111111111")
    expect(record.status).toBe("INACTIVE")
  })

  test("--dry-run does not write cache or state", async () => {
    const dir = tmp()
    const cache = join(dir, "nav_cache.jsonl")
    const state = join(dir, "nav_feed_state.json")
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/api/v1/feed" && url.searchParams.has("last")) return Response.json(fixture(FEED_LAST))
        if (url.pathname === "/api/v1/feed") return Response.json(fixture(FEED_PAGE_1))
        if (url.pathname === "/api/v1/feedentry/11111111-1111-4111-8111-111111111111") {
          return Response.json(fixture(DETAIL_ACTIVE))
        }
        if (url.pathname === "/api/v1/feed/fixture-page-2") return Response.json(fixture(FEED_PAGE_2))
        return new Response(JSON.stringify({ status: 404 }), { status: 404 })
      },
    })
    servers.push({ stop: () => server.stop(true) })

    const result = await runCLI(["sync", "--since", "3650", "--max-pages", "1", "--dry-run"], {
      NAV_API_TOKEN: "fixture-token",
      NAV_FEED_BASE_URL: server.url.origin,
      NAV_CACHE_PATH: cache,
      NAV_STATE_PATH: state,
      NAV_AREA_PATH: AREA_FIXTURE,
      NAV_EMPLOYERS_PATH: EMPLOYERS_FIXTURE,
    })
    expect(result.exitCode).toBe(0)
    const body = parseJSON<{ meta: { dry_run: boolean } }>(result)
    expect(body.meta.dry_run).toBe(true)
    expect(existsSync(cache)).toBe(false)
    expect(existsSync(state)).toBe(false)
  })

  test("sync without NAV_API_TOKEN exits 1 with MISSING_CREDENTIALS", async () => {
    const result = await runCLI(["sync"], { NAV_API_TOKEN: undefined })
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stderr).code).toBe("MISSING_CREDENTIALS")
  })
})
