import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  DETAIL_ACTIVE,
  DETAIL_INACTIVE,
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

function fixture(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"))
}

function server() {
  const instance = startFixtureServer({
    "/api/v1/feedentry/11111111-1111-4111-8111-111111111111": fixture(DETAIL_ACTIVE),
    "/api/v1/feedentry/44444444-4444-4444-8444-444444444444": fixture(DETAIL_INACTIVE),
  })
  servers.push(instance)
  return instance
}

function env(dir: string, base: string) {
  return {
    NAV_API_TOKEN: "fixture-token",
    NAV_FEED_BASE_URL: base,
    NAV_CACHE_PATH: join(dir, "nav_cache.jsonl"),
    NAV_STATE_PATH: join(dir, "nav_state.json"),
    NAV_EMPLOYERS_PATH: EMPLOYERS_FIXTURE,
  }
}

describe("detail", () => {
  test("returns normalized JSON for an active ad", async () => {
    const dir = tmp()
    const instance = server()
    const result = await runCLI(
      ["detail", "11111111-1111-4111-8111-111111111111", "--format", "json"],
      env(dir, instance.base),
    )
    expect(result.exitCode).toBe(0)
    const body = parseJSON<Record<string, unknown>>(result)
    expect(body.title).toBe("Utvikler")
    expect(body.company).toBe("TRONDHEIM KOMMUNE")
    expect(body.location).toBe("TRONDHEIM")
    expect(body.municipal).toBe("TRONDHEIM")
    expect(body.date).toBe("2026-11-05")
    expect(body.deadline).toBe("2026-11-25")
    expect(body.employment_type).toBe("Fast")
    expect(body.status).toBe("ACTIVE")
    expect(String(body.description)).toContain("Bygg systemer")
    expect(String(body.description)).not.toContain("evil")
    expect(String(body.description)).not.toContain("hemmelig")
    expect(String(body.url)).toContain("11111111-1111-4111-8111-111111111111")
  })

  test("accepts a feedentry path and prints readable plain text", async () => {
    const dir = tmp()
    const instance = server()
    const result = await runCLI(
      ["detail", "/api/v1/feedentry/11111111-1111-4111-8111-111111111111", "--format", "plain"],
      env(dir, instance.base),
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Utvikler")
    expect(result.stdout).toContain("Bygg systemer")
    expect(result.stdout).toContain("TypeScript")
    expect(result.stdout).toContain("Deadline: 2026-11-25")
    expect(result.stdout).toContain("URL:")
  })

  test("an inactive detail without ad_content falls back to the cached record", async () => {
    const dir = tmp()
    const cache = join(dir, "nav_cache.jsonl")
    writeCache(cache, [
      baseRecord({
        uuid: "44444444-4444-4444-8444-444444444444",
        id: "44444444-4444-4444-8444-444444444444",
        title: "Utvikler gammel",
        status: "INACTIVE",
      }),
    ])
    const instance = server()
    const result = await runCLI(
      ["detail", "44444444-4444-4444-8444-444444444444", "--format", "json"],
      { ...env(dir, instance.base), NAV_CACHE_PATH: cache },
    )
    expect(result.exitCode).toBe(0)
    const body = parseJSON<Record<string, unknown>>(result)
    expect(body.status).toBe("INACTIVE")
    expect(body.title).toBe("Utvikler gammel")
    expect(body.description).toBe("Bygg systemer")
  })

  test("a full public ad URL is accepted", async () => {
    const dir = tmp()
    const instance = server()
    const result = await runCLI(
      ["detail", "https://arbeidsplassen.nav.no/stillinger/stilling/11111111-1111-4111-8111-111111111111"],
      env(dir, instance.base),
    )
    expect(result.exitCode).toBe(0)
    const body = parseJSON<Record<string, unknown>>(result)
    expect(body.id).toBe("11111111-1111-4111-8111-111111111111")
  })

  test("404 returns NOT_FOUND and exit 1", async () => {
    const dir = tmp()
    const instance = server()
    const result = await runCLI(
      ["detail", "99999999-9999-4999-8999-999999999999"],
      env(dir, instance.base),
    )
    expect(result.exitCode).toBe(1)
    expect(parseError(result).code).toBe("NOT_FOUND")
  })
})
