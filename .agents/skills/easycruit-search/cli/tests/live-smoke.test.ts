import { expect, test } from "bun:test"
import { parseJSON, runCLI } from "./helpers"

// Opt-in network check: `EASYCRUIT_LIVE=1 bun run test`.
// The rest of the suite is fully offline through EASYCRUIT_FIXTURE_DIR.
const LIVE = process.env.EASYCRUIT_LIVE === "1"

interface SearchPayload {
  results: Array<{
    id: string | null
    title: string | null
    company: string | null
    location: string | null
    date: string | null
    url: string | null
  }>
}

test.skipIf(!LIVE)("live smoke: search -q lærer -l Stjørdal returns real results", async () => {
  const result = await runCLI([
    "search",
    "-q",
    "lærer",
    "-l",
    "Stjørdal",
    "--limit",
    "5",
    "--format",
    "json",
  ])
  expect(result.exitCode).toBe(0)
  const payload = parseJSON<SearchPayload>(result)

  expect(payload.results.length).toBeGreaterThan(0)
  for (const job of payload.results) {
    expect(job.id).toBeTruthy()
    expect(job.title).toBeTruthy()
    expect(job.url).toContain("easycruit.com")
    expect(job.location).toBeTruthy()
  }
})
