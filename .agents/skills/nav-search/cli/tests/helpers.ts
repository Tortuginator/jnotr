import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { NormRecord } from "../src/helpers.js"

const CLI_PATH = join(import.meta.dir, "../src/cli.ts")

export interface CLIResult {
  stdout: string
  stderr: string
  exitCode: number
}

export type Env = Record<string, string | undefined>

export async function runCLI(args: string[], env: Env = {}): Promise<CLIResult> {
  const merged: Record<string, string> = {}
  for (const [key, value] of Object.entries({ ...process.env, ...env })) {
    if (value !== undefined) merged[key] = value
  }
  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: merged,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode }
}

export function parseJSON<T = unknown>(result: CLIResult): T {
  if (result.exitCode !== 0) {
    throw new Error(`CLI exited with code ${result.exitCode}. stderr: ${result.stderr}`)
  }
  try {
    return JSON.parse(result.stdout) as T
  } catch {
    throw new Error(`Failed to parse JSON. stdout: ${result.stdout}\nstderr: ${result.stderr}`)
  }
}

export function parseError(result: CLIResult): { error: string; code: string } {
  try {
    return JSON.parse(result.stderr) as { error: string; code: string }
  } catch {
    throw new Error(`Failed to parse error JSON. stderr: ${result.stderr}\nstdout: ${result.stdout}`)
  }
}

export function tempDir(prefix = "nav-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

export function writeCache(path: string, records: NormRecord[]): void {
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n")
}

export function makeCacheStale(path: string, hours = 2): void {
  const old = new Date(Date.now() - hours * 3600 * 1000)
  utimesSync(path, old, old)
}

export interface FixtureServer {
  base: string
  requests: string[]
  stop: () => void
}

export function startFixtureServer(routes: Record<string, unknown>): FixtureServer {
  const requests: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      requests.push(url.pathname + url.search)
      const body = routes[url.pathname]
      if (body === undefined) {
        return new Response(JSON.stringify({ title: "Not found", status: 404 }), {
          status: 404,
          headers: { "content-type": "application/json" },
        })
      }
      return Response.json(body)
    },
  })
  return {
    base: server.url.origin,
    requests,
    stop: () => server.stop(true),
  }
}

export function baseRecord(overrides: Partial<NormRecord> = {}): NormRecord {
  const uuid = overrides.uuid ?? "11111111-1111-4111-8111-111111111111"
  return {
    id: uuid,
    uuid,
    title: "Utvikler",
    company: "TRONDHEIM KOMMUNE",
    raw_company: "TRONDHEIM KOMMUNE",
    location: "Trondheim",
    municipal: "TRONDHEIM",
    city: "TRONDHEIM",
    postal_code: "7013",
    date: "2026-11-05",
    date_modified: "2026-11-05T10:00:00+01:00",
    published: "2026-11-05T10:00:00+01:00",
    expires: "2026-11-25T00:00:00+01:00",
    deadline: "2026-11-25",
    status: "ACTIVE",
    description: "Bygg systemer",
    content_text: null,
    url: `https://arbeidsplassen.nav.no/stillinger/stilling/${uuid}`,
    orgnr: "942110464",
    employment_type: "Fast",
    extent: "Heltid",
    ...overrides,
  }
}

export function daysAgoDate(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
}

export function daysAgoTimestamp(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString()
}

export const AREA_FIXTURE = join(import.meta.dir, "fixtures/area.json")
export const EMPLOYERS_FIXTURE = join(import.meta.dir, "fixtures/employers.csv")
export const FEED_PAGE_1 = join(import.meta.dir, "fixtures/feed-page-1.json")
export const FEED_PAGE_2 = join(import.meta.dir, "fixtures/feed-page-2.json")
export const FEED_LAST = join(import.meta.dir, "fixtures/feed-last.json")
export const DETAIL_ACTIVE = join(import.meta.dir, "fixtures/detail-active.json")
export const DETAIL_INACTIVE = join(import.meta.dir, "fixtures/detail-inactive.json")
