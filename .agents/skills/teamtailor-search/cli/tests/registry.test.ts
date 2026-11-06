import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { normalizeRegistry, parseCsv } from "../src/helpers"
import { FIXTURES } from "./helpers"

const HEADER = "orgnr,name,aliases,trd_staff,nace,website,career_url,ats,ats_ref,confidence,enabled,status"

describe("parseCsv", () => {
  test("handles quoted commas, escaped quotes and CRLF", () => {
    const csv = `a,b,c\r\n1,"Comma, Name","say ""hi"""\r\n2,plain,value\r\n`
    expect(parseCsv(csv)).toEqual([
      ["a", "b", "c"],
      ["1", "Comma, Name", 'say "hi"'],
      ["2", "plain", "value"],
    ])
  })
})

describe("normalizeRegistry", () => {
  test("reads the fixture registry", () => {
    const registry = normalizeRegistry(readFileSync(join(FIXTURES, "employers.csv"), "utf8"))
    expect(registry.employers.map((e) => e.name)).toEqual(["Alpha AS", "Beta AS", "Fail Feed AS"])
    expect(registry.errors).toEqual([
      { employer: "Missing Ref AS", error: "missing ats_ref; employer skipped" },
    ])
  })

  test("uses the registry name as company and keeps orgnr", () => {
    const registry = normalizeRegistry(readFileSync(join(FIXTURES, "employers.csv"), "utf8"))
    const alpha = registry.employers.find((e) => e.name === "Alpha AS")
    expect(alpha?.feedUrl).toBe("https://alpha.teamtailor.com/jobs.rss")
    expect(alpha?.orgnr).toBe("111111111")
  })

  test("ignores disabled and non-Teamtailor rows", () => {
    const names = normalizeRegistry(readFileSync(join(FIXTURES, "employers.csv"), "utf8")).employers.map(
      (e) => e.name,
    )
    expect(names).not.toContain("Disabled AS")
    expect(names).not.toContain("Webcruiter AS")
  })

  test("reports an invalid ats_ref instead of guessing", () => {
    const csv = [
      HEADER,
      "1,Weird AS,,1,0,x,,teamtailor,https://weird.teamtailor.com/jobs,high,true,",
    ].join("\n")
    const registry = normalizeRegistry(csv)
    expect(registry.employers).toEqual([])
    expect(registry.errors[0].employer).toBe("Weird AS")
    expect(registry.errors[0].error).toContain("invalid ats_ref")
  })

  test("deduplicates two rows pointing at the same feed", () => {
    const csv = [
      HEADER,
      "1,First AS,,1,0,x,,teamtailor,https://shared.teamtailor.com/jobs.rss,high,true,",
      "2,Second AS,,1,0,x,,teamtailor,https://shared.teamtailor.com/jobs.rss,high,true,",
    ].join("\n")
    const registry = normalizeRegistry(csv)
    expect(registry.employers.map((e) => e.name)).toEqual(["First AS"])
  })

  test("accepts a quoted name containing a comma", () => {
    const csv = [
      HEADER,
      '1,"Comma, Name AS",,1,0,x,,teamtailor,https://comma.teamtailor.com/jobs.rss,high,true,',
    ].join("\n")
    expect(normalizeRegistry(csv).employers[0].name).toBe("Comma, Name AS")
  })

  test("treats an empty enabled column as enabled", () => {
    const csv = [
      "orgnr,name,ats,ats_ref,enabled",
      "1,Blank Enabled AS,teamtailor,https://blank.teamtailor.com/jobs.rss,",
    ].join("\n")
    expect(normalizeRegistry(csv).employers).toHaveLength(1)
  })
})
