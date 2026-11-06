import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  buildExtListUrl,
  companyForTarget,
  findReachmeeSources,
  loadArea,
  locationMatches,
  normalizeDetailTarget,
  parseAttractDetail,
  parseAttractList,
  parseExtDetail,
  parseExtList,
  parseSourceRef,
  resolveSource,
  websiteSlug,
  type Employer,
} from "../src/helpers"
import { collectResults } from "../src/commands/search"

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8")

const asplan: Employer = {
  orgnr: "910209205",
  name: "ASPLAN VIAK AS",
  aliases: "",
  website: "www.asplanviak.no",
  careerUrl: "https://www.asplanviak.no/karriere/",
  ats: "reachmee",
  atsRef: "https://web103.reachmee.com/ext/I010/2581",
  confidence: "high",
  enabled: true,
}

const sweco: Employer = {
  orgnr: "967032271",
  name: "SWECO NORGE AS",
  aliases: "",
  website: "www.sweco.no",
  careerUrl: "https://www.sweco.no/karrieresider/",
  ats: "reachmee",
  atsRef: "https://web103.reachmee.com/ext/I017/653",
  confidence: "high",
  enabled: true,
}

describe("ReachMee refs", () => {
  test("parses ext, host-only and Attract refs", () => {
    const ext = parseSourceRef(
      "https://web103.reachmee.com/ext/I010/2581/main?site=6&lang=NO&validator=bb6acbf35f424f0ddb47918d102863c3",
    )!
    expect(ext.kind).toBe("ext")
    expect(ext.code).toBe("I010")
    expect(ext.customer).toBe("2581")
    expect(ext.site).toBe("6")
    expect(ext.listUrl).toContain("/ext/I010/2581/main?site=6&lang=NO&validator=")

    const seed = parseSourceRef("https://web103.reachmee.com/ext/I003/475")!
    expect(seed.kind).toBe("ext")
    expect(seed.code).toBe("I003")
    expect(seed.customer).toBe("475")
    expect(seed.validator).toBeNull()
    expect(seed.listUrl).toBe("")

    const attract = parseSourceRef("https://nina.attract.reachmee.com")!
    expect(attract.kind).toBe("attract")
    expect(attract.listUrl).toBe("https://nina.attract.reachmee.com/jobs")

    expect(parseSourceRef("https://example.com/jobs")).toBeNull()
  })

  test("buildExtListUrl is the verified main URL shape", () => {
    expect(buildExtListUrl("https://web103.reachmee.com", "I010", "2581", "6", "NO", "abc")).toBe(
      "https://web103.reachmee.com/ext/I010/2581/main?site=6&lang=NO&validator=abc",
    )
  })

  test("websiteSlug strips www and schemes", () => {
    expect(websiteSlug("www.sweco.no")).toBe("sweco")
    expect(websiteSlug("https://www.asplanviak.no/karriere")).toBe("asplanviak")
    expect(websiteSlug("")).toBeNull()
  })

  test("finds a validator-bearing ReachMee link on a career page", () => {
    const sources = findReachmeeSources(fixture("career.html"))
    expect(sources).toHaveLength(1)
    expect(sources[0].code).toBe("I010")
    expect(sources[0].customer).toBe("2581")
    expect(sources[0].validator).toBe("bb6acbf35f424f0ddb47918d102863c3")
    expect(sources[0].listUrl).toContain("/main?")
  })
})

describe("ReachMee source resolution", () => {
  test("uses an Attract career site when the registry ref has no validator", async () => {
    const source = await resolveSource(sweco, async (url) => {
      if (url === "https://sweco.attract.reachmee.com/jobs") return fixture("attract-list.html")
      return null
    })
    expect(source?.kind).toBe("attract")
    expect(source?.listUrl).toBe("https://sweco.attract.reachmee.com/jobs")
  })

  test("discovers a validator from the registry career_url", async () => {
    const source = await resolveSource(asplan, async (url) => {
      if (url === "https://asplanviak.attract.reachmee.com/jobs") return null
      if (url === asplan.careerUrl) return fixture("career.html")
      return null
    })
    expect(source?.kind).toBe("ext")
    expect(source?.validator).toBe("bb6acbf35f424f0ddb47918d102863c3")
    expect(source?.listUrl).toBe(
      "https://web103.reachmee.com/ext/I010/2581/main?site=6&lang=NO&validator=bb6acbf35f424f0ddb47918d102863c3",
    )
  })

  test("reports an unresolvable seed ref as null", async () => {
    const bravida: Employer = {
      ...asplan,
      name: "BRAVIDA NORGE AS",
      website: "www.bravida.no",
      careerUrl: "https://www.bravida.no/jobbe-hos-oss/",
      atsRef: "https://web103.reachmee.com/ext/I003/475",
    }
    const source = await resolveSource(bravida, async () => null)
    expect(source).toBeNull()
  })
})

describe("ReachMee list parsing", () => {
  test("maps a legacy ext table, including null location and deadline-only date", () => {
    const rows = parseExtList(fixture("ext-list.html"), "ASPLAN VIAK AS", "https://web103.reachmee.com")
    expect(rows).toHaveLength(2)
    expect(rows[0].result).toEqual({
      id: "https://web103.reachmee.com/ext/I010/2581/job?site=6&lang=NO&validator=bb6acbf35f424f0ddb47918d102863c3&job_id=215",
      title: "Sommerjobb innen brannrådgivning!",
      company: "ASPLAN VIAK AS",
      location: "Oslo",
      date: null,
      url: "https://web103.reachmee.com/ext/I010/2581/job?site=6&lang=NO&validator=bb6acbf35f424f0ddb47918d102863c3&job_id=215",
    })
    expect(rows[1].result.location).toBeNull()
    expect(rows[1].result.date).toBeNull()
    expect(Object.keys(rows[1].result).sort()).toEqual(["company", "date", "id", "location", "title", "url"])
  })

  test("does not mistake a numeric id column for a location", () => {
    const html = `<table><thead><tr><th>Uppdragsid</th><th>Stilling</th><th>By</th></tr></thead>
      <tbody><tr><td>52</td><td><a href='https://web103.reachmee.com/ext/I010/2617/job?job_id=57'>Thesis</a></td><td></td></tr></tbody></table>`
    const rows = parseExtList(html, "SCALE AQUACULTURE AS", "https://web103.reachmee.com")
    expect(rows[0].result.location).toBeNull()
  })

  test("uses a published column when the list has one", () => {
    const rows = parseExtList(fixture("ext-list-published.html"), "FMV", "https://web103.reachmee.com")
    expect(rows.map((row) => row.result.date)).toEqual(["2026-11-04", "2026-10-20"])
    expect(rows.map((row) => row.result.location)).toEqual(["Stockholm", "Linköping"])
  })

  test("maps an Attract list and honours a published column", () => {
    const rows = parseAttractList(fixture("attract-list.html"), "SWECO NORGE AS", "https://sweco.attract.reachmee.com")
    expect(rows).toHaveLength(2)
    expect(rows[0].result.title).toBe("AI och järnväg i kombination")
    expect(rows[0].result.date).toBeNull()
    expect(rows[0].result.location).toBeNull()

    const published = parseAttractList(
      fixture("attract-list-with-published.html"),
      "DEMO",
      "https://demo.attract.reachmee.com",
    )
    expect(published[0].result.date).toBe("2026-11-05")
    expect(published[0].result.location).toBe("Trondheim")
  })
})

describe("ReachMee filters", () => {
  const area = loadArea()!

  test("area matching works on the listing location field", () => {
    expect(locationMatches("Trondheim", "area", area)).toBe(true)
    expect(locationMatches("Oslo", "area", area)).toBe(false)
    expect(locationMatches("", "area", area)).toBe(false)
  })
})

describe("ReachMee collectResults", () => {
  const broken: Employer = {
    ...asplan,
    name: "BROKEN REACHMEE AS",
    website: "www.broken.example",
    careerUrl: "",
    atsRef: "https://web103.reachmee.com/ext/I003/475",
  }

  const makeDeps = (extList: string, attractList: string) => {
    const employers = [asplan, sweco, broken]
    return {
      area: loadArea(),
      employers,
      fetchText: async (url: string) => {
        if (url === "https://asplanviak.attract.reachmee.com/jobs") return null
        if (url === asplan.careerUrl) return fixture("career.html")
        if (url.includes("/ext/I010/2581/main?")) return extList
        if (url === "https://sweco.attract.reachmee.com/jobs") return attractList
        return null
      },
    }
  }

  test("pools ext and Attract results and records a failing employer", async () => {
    const { results, errors } = await collectResults(
      { page: 1, format: "json" },
      makeDeps(fixture("ext-list.html"), fixture("attract-list.html")),
    )
    expect(results).toHaveLength(4)
    expect(errors).toHaveLength(1)
    expect(errors[0].employer).toBe("BROKEN REACHMEE AS")
    expect(errors[0].error).toContain("no usable ReachMee list source")
    expect(results.some((result) => result.company === "ASPLAN VIAK AS")).toBe(true)
    expect(results.some((result) => result.company === "SWECO NORGE AS")).toBe(true)
  })

  test("reads location from the detail page when the list omits it", async () => {
    const list = `<table class="jobsTableClass"><tbody><tr>
      <td><a href='https://web103.reachmee.com/ext/I010/2581/job?site=6&lang=NO&validator=x&job_id=215'>Sommerjobb</a></td>
      <td></td><td>10.11.2026</td></tr></tbody></table>`
    const employer = {
      ...asplan,
      atsRef: "https://web103.reachmee.com/ext/I010/2581/main?site=6&lang=NO&validator=x",
    }
    const deps = {
      area: loadArea(),
      employers: [employer],
      fetchText: async (url: string) => {
        if (url.includes("/ext/I010/2581/main?")) return list
        if (url.includes("job_id=215")) return fixture("ext-detail.html")
        return null
      },
    }
    const { results } = await collectResults({ page: 1, location: "Oslo", format: "json" }, deps)
    expect(results).toHaveLength(1)
    expect(results[0].location).toBe("Oslo, Drammen, Ås")
  })

  test("applies query, location and jobage filters", async () => {
    const deps = makeDeps(fixture("ext-list.html"), fixture("attract-list-with-published.html"))
    const query = await collectResults({ page: 1, query: "student", format: "json" }, deps)
    expect(query.results).toHaveLength(1)

    const location = await collectResults({ page: 1, location: "Oslo", format: "json" }, deps)
    expect(location.results).toHaveLength(1)

    const fresh = await collectResults({ page: 1, jobage: 3650, format: "json" }, deps)
    expect(fresh.results).toHaveLength(1)
    expect(fresh.results[0].date).toBe("2026-11-05")
  })
})

describe("ReachMee detail", () => {
  const extUrl =
    "https://web103.reachmee.com/ext/I010/2581/job?site=6&lang=NO&validator=bb6acbf35f424f0ddb47918d102863c3&job_id=215"
  const attractUrl = "https://sweco.attract.reachmee.com/jobs/25705-ai-och-jarnvag"

  test("normalises only ReachMee posting URLs", () => {
    expect(normalizeDetailTarget(extUrl)).toMatchObject({ kind: "ext", code: "I010", customer: "2581" })
    expect(normalizeDetailTarget(attractUrl)).toMatchObject({ kind: "attract" })
    expect(normalizeDetailTarget("215")).toBeNull()
    expect(normalizeDetailTarget("https://evil.example/job?job_id=215")).toBeNull()
  })

  test("parses an ext detail page and strips hidden/script text", () => {
    const target = normalizeDetailTarget(extUrl)!
    const job = parseExtDetail(fixture("ext-detail.html"), target)
    expect(job.title).toBe("Sommerjobb innen brannrådgivning!")
    expect(job.company).toBe("Asplan Viak AS")
    expect(job.location).toBe("Oslo, Drammen, Ås")
    expect(job.description).toContain("Sommerjobb i Asplan Viak")
    expect(job.description).toContain("Studerer branntekniske fag")
    expect(job.description).not.toContain("hideMe")
  })

  test("parses an Attract detail page", () => {
    const target = normalizeDetailTarget(attractUrl)!
    const job = parseAttractDetail(fixture("attract-detail.html"), target, "SWECO NORGE AS")
    expect(job.title).toBe("AI och järnväg i kombination")
    expect(job.company).toBe("SWECO NORGE AS")
    expect(job.location).toBe("Stockholm")
    expect(job.department).toBe("Järnväg")
    expect(job.deadline).toBe("2027-01-19")
    expect(job.description).toContain("AI-tillämpningar")
    expect(job.description).not.toContain("Hidden instruction")
  })

  test("resolves the registry company from ext code/customer or Attract slug", () => {
    expect(companyForTarget(normalizeDetailTarget(extUrl)!, [asplan])).toBe("ASPLAN VIAK AS")
    expect(companyForTarget(normalizeDetailTarget(attractUrl)!, [sweco])).toBe("SWECO NORGE AS")
  })
})
