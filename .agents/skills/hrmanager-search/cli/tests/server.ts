import { readFileSync } from "node:fs"
import { join } from "node:path"

const FIXTURES = join(import.meta.dir, "fixtures")

export interface TestServer {
  url: string
  requests: string[]
  stop: () => void
}

/** Local loopback server serving recorded HR Manager fixtures. */
export function startServer(): TestServer {
  const requests: string[] = []
  const files: Record<string, string> = {
    sparebank1: readFileSync(join(FIXTURES, "Sparebank1.xml"), "utf8"),
    mist: readFileSync(join(FIXTURES, "mist.xml"), "utf8"),
    resolve1004: readFileSync(join(FIXTURES, "resolve_1004.xml"), "utf8"),
    resolve139: readFileSync(join(FIXTURES, "resolve_139.xml"), "utf8"),
    detail: readFileSync(join(FIXTURES, "detail.html"), "utf8"),
  }
  let base = ""

  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      requests.push(url.pathname + url.search)
      const key = url.pathname.replace(/\/+$/, "")

      const xml = (body: string, status = 200) =>
        new Response(body.replaceAll("https://candidate.hr-manager.net", base), {
          status,
          headers: { "Content-Type": "application/xml; charset=utf-8" },
        })

      if (key === "/JobPortal.svc/Sparebank1/PositionList/rss") return xml(files.sparebank1)
      if (key === "/JobPortal.svc/mist/PositionList/rss") return xml(files.mist)
      if (key === "/JobPortal.svc/1004/PositionList/rss") return xml(files.resolve1004, 400)
      if (key === "/JobPortal.svc/139/PositionList/rss") return xml(files.resolve139, 400)
      if (key === "/ApplicationInit.aspx") {
        return new Response(files.detail, { headers: { "Content-Type": "text/html; charset=utf-8" } })
      }
      return new Response("not found", { status: 404 })
    },
  })

  base = `http://127.0.0.1:${server.port}`
  return {
    url: base,
    requests,
    stop: () => server.stop(true),
  }
}

export const FIXTURES_DIR = FIXTURES
