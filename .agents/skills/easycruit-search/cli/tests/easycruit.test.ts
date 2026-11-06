import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  combineLocation,
  fetchPublicDetail,
  htmlToTextDecoded,
  listXmlUrl,
  locationMatches,
  normalizeDate,
  normalizeRegistry,
  normalizeText,
  parseRss,
  parseVacancyList,
  parseVacancyXml,
  rssDescriptionsByTitle,
  rssUrl,
  textMatchesQuery,
  type AreaFile,
  type Employer,
  type FetchLike,
} from "../src/helpers"
import { DetailBudget, searchEmployer } from "../src/commands/search"
import { FIXTURES, fixtureEnv, parseJSON, runCLI } from "./helpers"

const area = JSON.parse(readFileSync(join(FIXTURES, "area.json"), "utf8")) as AreaFile
const stjordal: Employer = {
  name: "STJØRDAL KOMMUNE",
  orgnr: null,
  ats: "easycruit",
  atsRef: "https://stjordal.easycruit.com",
  baseUrl: "https://stjordal.easycruit.com",
  slug: "stjordal",
}
const listXml = readFileSync(join(FIXTURES, "stjordal.list.xml"), "utf8")
const UNTITLED_FIXTURES = join(FIXTURES, "untitled")

interface SearchPayload {
  meta: {
    count: number
    page: number
    totalMatched: number
    errors: Array<{ employer: string; error: string }>
  }
  results: Array<{
    id: string
    title: string | null
    company: string | null
    location: string | null
    date: string | null
    url: string | null
  }>
}

interface DetailPayload {
  id: string
  title: string | null
  company: string | null
  location: string | null
  date: string | null
  url: string | null
  description: string | null
  deadline: string | null
  employmentType: string | null
}

describe("EasyCruit feed parsing", () => {
  test("the XML joblist supplies unique IDs and date_start", () => {
    const xml = readFileSync(join(FIXTURES, "stjordal.list.xml"), "utf8")
    const vacancies = parseVacancyList(xml)

    expect(vacancies.length).toBe(13)
    expect(vacancies[0].id).toBe("3622391")
    expect(vacancies[0].title).toBe("Støttekontakt")
    const fastlege = vacancies.find((vacancy) => vacancy.id === "3673377")
    expect(fastlege?.title).toBe("Ledig 0-hjemmel for fastlege ved Skatval legekontor")
    expect(fastlege?.dateStart).toBe("2026-11-05")
    expect(fastlege?.location).toBe("Skatval legekontor")
  })

  test("RSS descriptions join to the XML rows by title", () => {
    const rss = parseRss(readFileSync(join(FIXTURES, "stjordal.rss"), "utf8"))
    const descriptions = rssDescriptionsByTitle(rss)

    expect(rss.length).toBe(13)
    const description = descriptions.get(
      normalizeText("Ledig 0-hjemmel for fastlege ved Skatval legekontor"),
    )
    expect(description).toContain("Skatval legesenter")
    expect(description).not.toContain("<p>")
  })

  test("the RSS link field is not a unique ID", () => {
    const rss = parseRss(readFileSync(join(FIXTURES, "stjordal.rss"), "utf8"))
    const links = new Set(rss.map((item) => item.link))
    // This is the quirk the CLI works around: one link for every item.
    expect(links.size).toBe(1)
  })

  test("XML title and location are decoded exactly once", () => {
    const xml =
      '<Vacancy id="1"><Versions><Version language="nb">' +
      '<Title>&amp;lt;script&amp;gt;SECRET&amp;lt;/script&amp;gt;</Title>' +
      '<Location>&amp;lt;template&amp;gt;SECRET&amp;lt;/template&amp;gt;</Location>' +
      "</Version></Versions></Vacancy>"
    const [vacancy] = parseVacancyList(xml)

    expect(vacancy.title).toBe("&lt;script&gt;SECRET&lt;/script&gt;")
    expect(vacancy.location).toBe("&lt;template&gt;SECRET&lt;/template&gt;")
    expect(vacancy.title).not.toContain("<script>")
    expect(vacancy.location).not.toContain("<template>")
  })

  test("XML description entities are decoded exactly once before htmlToText", () => {
    const xml =
      '<Vacancy id="1"><Versions><Version language="nb">' +
      "<Description>&lt;p&gt;A &amp;lt;script&amp;gt;SECRET&amp;lt;/script&amp;gt;&lt;/p&gt;</Description>" +
      "</Version></Versions></Vacancy>"
    const detail = parseVacancyXml(xml)

    expect(detail?.descriptionHtml).toBe("<p>A &lt;script&gt;SECRET&lt;/script&gt;</p>")
    expect(htmlToTextDecoded(detail?.descriptionHtml)).toBe(
      "A &lt;script&gt;SECRET&lt;/script&gt;",
    )
  })
})

describe("matching", () => {
  test("query matching keeps Norwegian compounds together", () => {
    expect(textMatchesQuery("Lærervikar", "lærer")).toBe(true)
    expect(textMatchesQuery("Barnehagelærer/ped.leder - vikarer", "lærer")).toBe(true)
    expect(textMatchesQuery("Sykepleier", "lærer")).toBe(false)
  })

  test("area matching is whole-token, not substring", () => {
    expect(locationMatches("Venn", "area", area)).toBe(true)
    expect(locationMatches("Vennesla", "area", area)).toBe(false)
    expect(locationMatches("Hell", "area", area)).toBe(true)
    expect(locationMatches("Helle", "area", area)).toBe(false)
    expect(locationMatches("Rye", "area", area)).toBe(true)
    expect(locationMatches("Ryen", "area", area)).toBe(false)
  })

  test("a municipality matches its places", () => {
    expect(locationMatches("Skatval legekontor", "Stjørdal", area)).toBe(true)
    expect(locationMatches("Skatval legekontor", "area", area)).toBe(true)
    expect(locationMatches("Campus Oslo", "area", area)).toBe(false)
    expect(locationMatches("Campus Oslo", "Trondheim", area)).toBe(false)
  })

  test("a named place does not expand to its parent municipality", () => {
    expect(locationMatches("Skatval legekontor", "Skatval", area)).toBe(true)
    expect(locationMatches("Hell", "Skatval", area)).toBe(false)
    expect(locationMatches("Stjørdal", "Skatval", area)).toBe(false)

    expect(locationMatches("Hell", "Hell", area)).toBe(true)
    expect(locationMatches("Skatval legekontor", "Hell", area)).toBe(false)
    expect(locationMatches("Stjørdal helsehus", "Hell", area)).toBe(false)
  })

  test("area matches every municipality and place in the area file", () => {
    for (const municipality of area.municipalities) {
      expect(locationMatches(municipality.name, "area", area)).toBe(true)
      for (const place of municipality.places ?? []) {
        expect(locationMatches(place, "area", area)).toBe(true)
      }
    }
  })

  test("combining a department with its municipality stays readable", () => {
    expect(combineLocation("Ved våre barnehager", "Stjørdal", "STJØRDAL KOMMUNE")).toBe(
      "Ved våre barnehager, Stjørdal",
    )
    expect(combineLocation("Stjørdal helsehus", "Stjørdal", "STJØRDAL KOMMUNE")).toBe("Stjørdal helsehus")
    expect(combineLocation(null, "Stjørdal", "STJØRDAL KOMMUNE")).toBe("Stjørdal")
    expect(combineLocation(null, null)).toBeNull()
    expect(combineLocation("Ved våre barnehager", "Stjørdal")).toBe("Ved våre barnehager")
  })

  test("an Oslo workplace at Stjørdal kommune is not turned into an area match", () => {
    const location = combineLocation("Oslo", "Stjørdal", "STJØRDAL KOMMUNE")
    expect(location).toBe("Oslo")
    expect(locationMatches(location, "area", area)).toBe(false)
  })

  test("multi-word out-of-area workplaces keep their own place name", () => {
    for (const workplace of ["Oslo sentrum", "Bergen sentrum", "Voss sjukehus"]) {
      const location = combineLocation(workplace, "Stjørdal", "STJØRDAL KOMMUNE")
      expect(location).toBe(workplace)
      expect(locationMatches(location, "area", area)).toBe(false)
    }
  })

  test("departmental workplaces still get the municipality hint", () => {
    expect(combineLocation("Sektor helse", "Stjørdal", "STJØRDAL KOMMUNE")).toBe(
      "Sektor helse, Stjørdal",
    )
    expect(locationMatches("Sektor helse, Stjørdal", "area", area)).toBe(true)
  })

  test("dates accept the XML and Norwegian deadline forms", () => {
    expect(normalizeDate("2026-11-05")).toBe("2026-11-05")
    expect(normalizeDate("01.12.2026")).toBe("2026-12-01")
    expect(normalizeDate("not a date")).toBeNull()
  })
})

describe("registry normalization", () => {
  const header = "orgnr,name,aliases,trd_staff,nace,website,career_url,ats,ats_ref,confidence,enabled,status\n"

  test("an easycruit row with an invalid ref is reported, not silently corrected", () => {
    const registry = normalizeRegistry(
      header + "939958851,STJØRDAL KOMMUNE,,,,,,easycruit,https://wrong.example.com,high,true,\n",
    )
    expect(registry.employers).toEqual([])
    expect(registry.errors).toContainEqual({
      employer: "STJØRDAL KOMMUNE",
      error: "missing or invalid ats_ref; employer skipped",
    })
  })

  test("a non-easycruit row is skipped without an error", () => {
    const registry = normalizeRegistry(
      header + "1,OTHER AS,,,,,,teamtailor,https://other.teamtailor.com,high,true,\n",
    )
    expect(registry.employers).toEqual([])
    expect(registry.errors).toEqual([])
  })

  test("a valid easycruit ref is used as the base URL", () => {
    const registry = normalizeRegistry(
      header + "939958851,STJØRDAL KOMMUNE,,,,,,easycruit,https://stjordal.easycruit.com,high,true,\n",
    )
    expect(registry.errors).toEqual([])
    expect(registry.employers[0].baseUrl).toBe("https://stjordal.easycruit.com")
  })
})

describe("feed requests and detail errors", () => {
  function mockFetch(handlers: Record<string, () => Response>, requested: string[]): FetchLike {
    return async (input) => {
      const url = String(input)
      requested.push(url)
      const handler = handlers[url]
      if (handler) return handler()
      return new Response("", { status: 404 })
    }
  }

  test("area-only search does not fetch the RSS feed", async () => {
    const requested: string[] = []
    const fetchImpl = mockFetch(
      { [listXmlUrl(stjordal.baseUrl)]: () => new Response(listXml, { status: 200 }) },
      requested,
    )
    const outcome = await searchEmployer(
      stjordal,
      { location: "area", page: 1, format: "json" },
      area,
      new DetailBudget(0),
      fetchImpl,
    )

    expect(requested).toEqual([listXmlUrl(stjordal.baseUrl)])
    expect(outcome.results.length).toBe(13)
  })

  test("query search fetches the RSS feed for descriptions", async () => {
    const rss = readFileSync(join(FIXTURES, "stjordal.rss"), "utf8")
    const requested: string[] = []
    const fetchImpl = mockFetch(
      {
        [listXmlUrl(stjordal.baseUrl)]: () => new Response(listXml, { status: 200 }),
        [rssUrl(stjordal.baseUrl)]: () => new Response(rss, { status: 200 }),
      },
      requested,
    )
    const outcome = await searchEmployer(
      stjordal,
      { query: "lærer", page: 1, format: "json" },
      area,
      new DetailBudget(0),
      fetchImpl,
    )

    expect(requested).toContain(rssUrl(stjordal.baseUrl))
    expect(outcome.results.some((job) => /lærer/i.test(job.title ?? ""))).toBe(true)
  })

  test("a WAF 202 during a detail fetch is returned as an error", async () => {
    const outcome = await fetchPublicDetail(
      stjordal.baseUrl,
      "3673377",
      async () => new Response("", { status: 202 }),
    )
    expect(outcome.detail).toBeNull()
    expect(outcome.error).toMatch(/WAF challenge|HTTP 202/i)
  })

  test("a genuine 404 detail is null without an error", async () => {
    const outcome = await fetchPublicDetail(
      stjordal.baseUrl,
      "9999999",
      async () => new Response("", { status: 404 }),
    )
    expect(outcome).toEqual({ detail: null, error: null })
  })

  test("a WAF challenge during query enrichment is reported, not swallowed", async () => {
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input)
      if (url === listXmlUrl(stjordal.baseUrl)) return new Response(listXml, { status: 200 })
      if (url === rssUrl(stjordal.baseUrl)) return new Response("<rss><channel></channel></rss>", { status: 200 })
      return new Response("", { status: 202 })
    }
    const outcome = await searchEmployer(
      stjordal,
      { query: "lærer", page: 1, format: "json" },
      area,
      new DetailBudget(5),
      fetchImpl,
    )

    expect(outcome.errors.some((entry) => /WAF challenge|HTTP 202/i.test(entry.error))).toBe(true)
  })
})

describe("search over fixtures", () => {
  test("area search populates the six contract fields", async () => {
    const result = await runCLI(["search", "-l", "area", "--limit", "5", "--format", "json"], fixtureEnv())
    const payload = parseJSON<SearchPayload>(result)

    expect(payload.meta.page).toBe(1)
    expect(payload.meta.count).toBe(payload.results.length)
    expect(payload.results.length).toBeGreaterThan(0)
    for (const job of payload.results) {
      expect(job.id).toMatch(/^stjordal\/\d+$/)
      expect(job.title).toBeTruthy()
      expect(job.company).toBe("STJØRDAL KOMMUNE")
      expect(job.location).toBeTruthy()
      expect(job.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(job.url).toContain("stjordal.easycruit.com/vacancy/")
      expect(Object.keys(job).sort()).toEqual(["company", "date", "id", "location", "title", "url"])
    }
  })

  test("a missing ats_ref is reported in meta.errors without failing the run", async () => {
    const result = await runCLI(["search", "-l", "area", "--limit", "1", "--format", "json"], fixtureEnv())
    const payload = parseJSON<SearchPayload>(result)

    expect(result.exitCode).toBe(0)
    expect(payload.meta.errors).toContainEqual({
      employer: "EMPTY REF AS",
      error: "missing or invalid ats_ref; employer skipped",
    })
  })

  test("-q lærer matches Lærervikar and keeps a usable location", async () => {
    const result = await runCLI(
      ["search", "-q", "lærer", "-l", "Stjørdal", "--limit", "10", "--format", "json"],
      fixtureEnv(),
    )
    const payload = parseJSON<SearchPayload>(result)

    expect(payload.results.length).toBeGreaterThan(0)
    expect(payload.results.some((job) => /lærer/i.test(job.title ?? ""))).toBe(true)
    expect(payload.results.every((job) => Boolean(job.location))).toBe(true)
  })

  test("table/plain mode keeps the employer error summary off stdout", async () => {
    const result = await runCLI(["search", "-l", "area", "--limit", "1", "--format", "table"], fixtureEnv())

    expect(result.exitCode).toBe(0)
    expect(result.stdout).not.toContain("reported errors")
    expect(result.stderr).toContain("employer(s) reported errors")
  })

  test("a missing title is null in JSON and (untitled) only in text output", async () => {
    const env = {
      EASYCRUIT_FIXTURE_DIR: UNTITLED_FIXTURES,
      EASYCRUIT_REGISTRY: join(UNTITLED_FIXTURES, "employers.csv"),
      EASYCRUIT_AREA: join(FIXTURES, "area.json"),
    }

    const json = await runCLI(["search", "-l", "area", "--format", "json"], env)
    const payload = parseJSON<SearchPayload>(json)
    expect(payload.results[0].title).toBeNull()

    const table = await runCLI(["search", "-l", "area", "--format", "table"], env)
    expect(table.stdout).toContain("(untitled)")

    const plain = await runCLI(["search", "-l", "area", "--format", "plain"], env)
    expect(plain.stdout).toContain("(untitled)")
  })
})

describe("detail over fixtures", () => {
  test("parses the public HTML detail and XML date", async () => {
    const result = await runCLI(["detail", "stjordal/3673377", "--format", "json"], fixtureEnv())
    const job = parseJSON<DetailPayload>(result)

    expect(job.id).toBe("stjordal/3673377")
    expect(job.title).toBe("Ledig 0-hjemmel for fastlege ved Skatval legekontor")
    expect(job.company).toBe("STJØRDAL KOMMUNE")
    expect(job.location).toContain("Skatval legekontor")
    expect(job.date).toBe("2026-11-05")
    expect(job.url).toContain("/vacancy/3673377")
    expect(job.description).toContain("Skatval legesenter")
    expect(job.deadline).toBe("01.12.2026")
  })

  test("plain output is readable", async () => {
    const result = await runCLI(["detail", "stjordal/3673377", "--format", "plain"], fixtureEnv())
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Ledig 0-hjemmel for fastlege ved Skatval legekontor")
    expect(result.stdout).toContain("STJØRDAL KOMMUNE")
    expect(result.stdout).toContain("Skatval legekontor")
    expect(result.stdout).toContain("URL: https://")
    expect(result.stdout).toContain("Skatval legesenter")
  })

  test("a full EasyCruit vacancy URL resolves the slug", async () => {
    const result = await runCLI(
      ["detail", "https://stjordal.easycruit.com/vacancy/3673377/240761?iso=no", "--format", "json"],
      fixtureEnv(),
    )
    expect(result.exitCode).toBe(0)
    expect(parseJSON<DetailPayload>(result).id).toBe("stjordal/3673377")
  })

  test("a bare vacancy id is rejected instead of guessing an employer", async () => {
    const result = await runCLI(["detail", "3673377", "--format", "json"], fixtureEnv())
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe("")
    expect(JSON.parse(result.stderr).code).toBe("BARE_ID")
  })
})

describe("CLI contract", () => {
  test("an unknown flag exits 1 with JSON on stderr", async () => {
    const result = await runCLI(["search", "--bogus", "value"], fixtureEnv())
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe("")
    expect(JSON.parse(result.stderr).code).toBe("UNKNOWN_FLAG")
  })

  test("an invalid --format exits 1", async () => {
    const result = await runCLI(["search", "--format", "xml"], fixtureEnv())
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stderr).code).toBe("BAD_ARG")
  })

  test("detail without an id exits 1", async () => {
    const result = await runCLI(["detail"], fixtureEnv())
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stderr).code).toBe("NO_ID")
  })

  test("a foreign URL is rejected before any fetch", async () => {
    const result = await runCLI(["detail", "https://evil.example/vacancy/3673377"], fixtureEnv())
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stderr).code).toBe("BAD_ID")
  })

  test("a missing registry exits 1 with NO_REGISTRY", async () => {
    const result = await runCLI(["search"], {
      EASYCRUIT_REGISTRY: "/nonexistent/easycruit-test/employers.csv",
    })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe("")
    expect(JSON.parse(result.stderr).code).toBe("NO_REGISTRY")
  })
})
