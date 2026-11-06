import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { readFileSync } from "node:fs"
import {
  AREA_FIXTURE,
  DETAIL_ACTIVE,
  EMPLOYERS_FIXTURE,
  baseRecord,
  cleanup,
  parseError,
  parseJSON,
  runCLI,
  startFixtureServer,
  tempDir,
  writeCache,
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

describe("search CLI contract", () => {
  test("emits {meta:{count,page},results} with all required fields present", async () => {
    const dir = tmp()
    const cache = join(dir, "nav_cache.jsonl")
    writeCache(cache, [baseRecord()])
    const result = await runCLI(["search"], {
      NAV_CACHE_PATH: cache,
      NAV_STATE_PATH: join(dir, "state.json"),
      NAV_AREA_PATH: AREA_FIXTURE,
      NAV_EMPLOYERS_PATH: EMPLOYERS_FIXTURE,
      NAV_API_TOKEN: undefined,
    })
    expect(result.exitCode).toBe(0)
    const body = parseJSON<{ meta: { count: number; page: number }; results: Record<string, unknown>[] }>(result)
    expect(body.meta.count).toBe(1)
    expect(body.meta.page).toBe(1)
    expect(body.results).toHaveLength(1)
    for (const field of ["id", "title", "company", "location", "date", "url"]) {
      expect(body.results[0]).toHaveProperty(field)
    }
    expect(body.results[0].date).toBe("2026-11-05")
    expect(body.results[0].company).toBe("TRONDHEIM KOMMUNE")
  })

  test("unknown flags exit 1 with UNKNOWN_FLAG on stderr", async () => {
    const result = await runCLI(["search", "--bogus", "x"])
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe("")
    expect(parseError(result).code).toBe("UNKNOWN_FLAG")
  })

  test("invalid format exits 1 with BAD_ARG", async () => {
    const result = await runCLI(["search", "--format", "xml"])
    expect(result.exitCode).toBe(1)
    expect(parseError(result).code).toBe("BAD_ARG")
  })

  test("a bare --query is rejected instead of silently ignored", async () => {
    const result = await runCLI(["search", "--query"])
    expect(result.exitCode).toBe(1)
    expect(parseError(result).code).toBe("BAD_ARG")
  })

  test("missing cache and missing token exits 1 with MISSING_CREDENTIALS", async () => {
    const dir = tmp()
    const result = await runCLI(["search", "-q", "test"], {
      NAV_CACHE_PATH: join(dir, "missing.jsonl"),
      NAV_STATE_PATH: join(dir, "state.json"),
      NAV_API_TOKEN: undefined,
    })
    expect(result.exitCode).toBe(1)
    const error = parseError(result)
    expect(error.code).toBe("MISSING_CREDENTIALS")
    expect(error.error).toContain("NAV_API_TOKEN")
  })

  test("unknown command exits 1", async () => {
    const result = await runCLI(["nope"])
    expect(result.exitCode).toBe(1)
    expect(parseError(result).code).toBe("BAD_CMD")
  })
})

describe("detail CLI contract", () => {
  test("fetches and prints a readable detail", async () => {
    const dir = tmp()
    const server = startFixtureServer({
      "/api/v1/feedentry/11111111-1111-4111-8111-111111111111": JSON.parse(readFileSync(DETAIL_ACTIVE, "utf8")),
    })
    servers.push(server)
    const result = await runCLI(
      ["detail", "11111111-1111-4111-8111-111111111111", "--format", "json"],
      {
        NAV_API_TOKEN: "fixture-token",
        NAV_FEED_BASE_URL: server.base,
        NAV_CACHE_PATH: join(dir, "cache.jsonl"),
        NAV_STATE_PATH: join(dir, "state.json"),
        NAV_EMPLOYERS_PATH: EMPLOYERS_FIXTURE,
      },
    )
    expect(result.exitCode).toBe(0)
    const body = parseJSON<Record<string, unknown>>(result)
    expect(body.title).toBe("Utvikler")
    expect(body.company).toBe("TRONDHEIM KOMMUNE")
    expect(body.location).toBe("TRONDHEIM")
    expect(body.deadline).toBe("2026-11-25")
    expect(body.url).toContain("/stillinger/stilling/")
  })

  test("plain detail strips hidden text and preserves paragraph breaks", async () => {
    const dir = tmp()
    const server = startFixtureServer({
      "/api/v1/feedentry/11111111-1111-4111-8111-111111111111": JSON.parse(readFileSync(DETAIL_ACTIVE, "utf8")),
    })
    servers.push(server)
    const result = await runCLI(
      ["detail", "/api/v1/feedentry/11111111-1111-4111-8111-111111111111", "--format", "plain"],
      {
        NAV_API_TOKEN: "fixture-token",
        NAV_FEED_BASE_URL: server.base,
        NAV_CACHE_PATH: join(dir, "cache.jsonl"),
        NAV_STATE_PATH: join(dir, "state.json"),
      },
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Bygg systemer")
    expect(result.stdout).toContain("TypeScript")
    expect(result.stdout).not.toContain("evil")
    expect(result.stdout).not.toContain("hemmelig")
    expect(result.stdout).toContain("URL:")
  })

  test("missing token exits 1 with MISSING_CREDENTIALS", async () => {
    const result = await runCLI(["detail", "11111111-1111-4111-8111-111111111111"], {
      NAV_API_TOKEN: undefined,
    })
    expect(result.exitCode).toBe(1)
    expect(parseError(result).code).toBe("MISSING_CREDENTIALS")
  })

  test("invalid id exits 1 with BAD_ID", async () => {
    const result = await runCLI(["detail", "not-a-job"], { NAV_API_TOKEN: "fixture-token" })
    expect(result.exitCode).toBe(1)
    expect(parseError(result).code).toBe("BAD_ID")
  })

  test("404 exits 1 with NOT_FOUND", async () => {
    const dir = tmp()
    const server = startFixtureServer({})
    servers.push(server)
    const result = await runCLI(["detail", "99999999-9999-4999-8999-999999999999"], {
      NAV_API_TOKEN: "fixture-token",
      NAV_FEED_BASE_URL: server.base,
      NAV_CACHE_PATH: join(dir, "cache.jsonl"),
      NAV_STATE_PATH: join(dir, "state.json"),
    })
    expect(result.exitCode).toBe(1)
    expect(parseError(result).code).toBe("NOT_FOUND")
  })
})
