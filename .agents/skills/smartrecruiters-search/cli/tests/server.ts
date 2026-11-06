import { readFileSync } from "node:fs"
import { join } from "node:path"

const FIXTURES = join(import.meta.dir, "fixtures")

export interface TestServer {
  url: string
  requests: string[]
  stop: () => void
}

/**
 * Local loopback server serving the recorded fixtures. Tests never touch the
 * real SmartRecruiters API.
 */
export function startServer(): TestServer {
  const requests: string[] = []
  const postings = readFileSync(join(FIXTURES, "postings.json"), "utf8")
  const detail = readFileSync(join(FIXTURES, "detail.json"), "utf8")

  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      requests.push(url.pathname + url.search)
      const key = url.pathname

      if (key === "/v1/companies/SopraSteria1/postings") {
        return new Response(postings, { headers: { "Content-Type": "application/json" } })
      }
      if (key === "/v1/companies/SopraSteria1/postings/744000160192843") {
        return new Response(detail, { headers: { "Content-Type": "application/json" } })
      }
      if (key.endsWith("/postings")) {
        return new Response(JSON.stringify({ offset: 0, limit: 100, totalFound: 0, content: [] }), {
          headers: { "Content-Type": "application/json" },
        })
      }
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  }
}

export const FIXTURES_DIR = FIXTURES
