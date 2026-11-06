import { join } from "path"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"

const CLI_PATH = join(import.meta.dir, "../src/cli.ts")

export interface CLIResult {
  stdout: string
  stderr: string
  exitCode: number
}

export async function runCLI(args: string[], preload?: string): Promise<CLIResult> {
  const proc = Bun.spawn(["bun", "run", ...(preload ? ["--preload", preload] : []), CLI_PATH, ...args], {
    stdout: "pipe",
    stderr: "pipe",
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

function fixture(name: string): Promise<unknown> {
  return Bun.file(join(import.meta.dir, "fixtures", name)).json()
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  })
}

/**
 * Run the real CLI against an in-process fixture server, with a preload that
 * rewrites Jobbnorge requests to it. Nothing leaves the machine, so the same
 * assertions can run in CI without touching the live portal.
 */
export async function runWithFixtures(args: string[]): Promise<{ result: CLIResult; requests: URL[] }> {
  const requests: URL[] = []

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      requests.push(url)

      if (url.pathname === "/v1/County") {
        return jsonResponse(await fixture("county.json"))
      }
      if (url.pathname === "/v1/Jobs") {
        return jsonResponse(await fixture("jobs.json"))
      }
      if (url.pathname === "/api/joblisting/job-info") {
        if (url.searchParams.get("jobId") === "404") return new Response(null, { status: 404 })
        return jsonResponse(await fixture("job-info.json"))
      }
      if (url.pathname === "/api/joblisting") {
        // The fixture job exists only in English (languageId 2), exercising
        // the CLI's language fallback: 1 -> 2.
        if (url.searchParams.get("jobId") === "404") return new Response(null, { status: 404 })
        if (url.searchParams.get("languageId") !== "2") return new Response(null, { status: 404 })
        return jsonResponse(await fixture("joblisting.json"))
      }

      return new Response(null, { status: 404 })
    },
  })

  const dir = mkdtempSync(join(tmpdir(), "jobbnorge-fixtures-"))
  const preload = join(dir, "fetch.ts")
  writeFileSync(
    preload,
    `
      const originalFetch = globalThis.fetch;
      const fixtureOrigin = ${JSON.stringify(server.url.origin)};
      const fixtureHosts = new Set(["publicapi.jobbnorge.no", "id.jobbnorge.no"]);
      globalThis.fetch = (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (!fixtureHosts.has(url.hostname)) {
          throw new Error("Unexpected fixture request: " + url.hostname + url.pathname);
        }
        return originalFetch(fixtureOrigin + url.pathname + url.search, init);
      };
    `,
  )

  try {
    return { result: await runCLI(args, preload), requests }
  } finally {
    server.stop(true)
    rmSync(dir, { recursive: true, force: true })
  }
}
