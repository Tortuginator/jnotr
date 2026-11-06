import { describe, expect, test } from "bun:test"
import {
  htmlToText,
  isInArea,
  loadArea,
  loadEmployers,
  mergeRecord,
  normalizeCompany,
  parseUuid,
  stripInvisible,
  visibleHtml,
} from "../src/helpers.js"
import { AREA_FIXTURE, EMPLOYERS_FIXTURE, baseRecord } from "./helpers.js"

describe("htmlToText", () => {
  test("removes hidden markup and keeps paragraph/list breaks", () => {
    const text = htmlToText(
      "<p>Bygg <strong>systemer</strong>.</p><script>evil()</script><p hidden>hemmelig</p><ul><li>TypeScript</li><li>SQL</li></ul>",
    )
    expect(text).toContain("Bygg systemer.")
    expect(text).toContain("TypeScript")
    expect(text).toContain("SQL")
    expect(text).not.toContain("evil")
    expect(text).not.toContain("hemmelig")
    expect(text).toContain("\n")
  })

  test("decodes entities", () => {
    expect(htmlToText("<p>Trondheim &amp; omegn&nbsp;2026</p>")).toBe("Trondheim & omegn 2026")
  })
})

describe("visibleHtml and stripInvisible", () => {
  test("visibleHtml drops comments and hidden elements", () => {
    const visible = visibleHtml("<!-- secret --><div>a</div><div style=\"display:none\">b</div><div>c</div>")
    expect(visible).toContain("a")
    expect(visible).toContain("c")
    expect(visible).not.toContain("secret")
    expect(visible).not.toContain("b")
  })

  test("stripInvisible removes zero-width and bidi characters recursively", () => {
    const value = { title: "Ut\u200Bvik\u202Eler", items: ["a\uFEFFb"] }
    expect(stripInvisible(value)).toEqual({ title: "Utvikler", items: ["ab"] })
  })
})

describe("normalizeCompany", () => {
  const employers = loadEmployers(EMPLOYERS_FIXTURE)

  test("matches the canonical name", () => {
    expect(normalizeCompany("TRONDHEIM KOMMUNE", null, employers)).toBe("TRONDHEIM KOMMUNE")
  })

  test("matches an alias", () => {
    expect(normalizeCompany("Trondheim kommune helse og velferd", null, employers)).toBe("TRONDHEIM KOMMUNE")
  })

  test("matches by organisation number", () => {
    expect(normalizeCompany("Some unit name", "942 110 464", employers)).toBe("TRONDHEIM KOMMUNE")
  })

  test("matches a long parent name inside a unit name", () => {
    const inline = [{ orgnr: null, name: "DOMSTOLADMINISTRASJONEN", aliases: [] }]
    expect(
      normalizeCompany("Avdeling for informasjon og teknologi, Domstoladministrasjonen", null, inline),
    ).toBe("DOMSTOLADMINISTRASJONEN")
  })

  test("matches a hospital sub-unit despite the legal suffix", () => {
    const inline = [{ orgnr: null, name: "ST. OLAVS HOSPITAL HF", aliases: [] }]
    expect(
      normalizeCompany(
        "Bildediagnostikk - Seksjon røntgenradiografer, St. Olavs hospital",
        null,
        inline,
      ),
    ).toBe("ST. OLAVS HOSPITAL HF")
    expect(
      normalizeCompany("NEVROKLINIKKEN, St. Olavs hospital", null, inline),
    ).toBe("ST. OLAVS HOSPITAL HF")
  })

  test("does not let a short single token absorb a longer company", () => {
    const inline = [{ orgnr: null, name: "SINTEF AS", aliases: ["SINTEF"] }]
    expect(normalizeCompany("SINTEF Ocean AS", null, inline)).toBe("SINTEF Ocean AS")
  })

  test("keeps an unmatched employer", () => {
    expect(normalizeCompany("Ukjent AS", null, employers)).toBe("Ukjent AS")
  })
})

describe("area matching", () => {
  const area = loadArea(AREA_FIXTURE)

  test("matches municipality names case-insensitively", () => {
    expect(isInArea(baseRecord({ municipal: "TRONDHEIM", location: "Trondheim" }), area)).toBe(true)
    expect(isInArea(baseRecord({ municipal: "STJØRDAL", location: "Stjørdal" }), area)).toBe(true)
    expect(isInArea(baseRecord({ municipal: "OSLO", location: "Oslo", postal_code: null }), area)).toBe(false)
  })

  test("matches postal prefixes", () => {
    expect(isInArea(baseRecord({ municipal: null, location: null, postal_code: "7030" }), area)).toBe(true)
    expect(isInArea(baseRecord({ municipal: null, location: null, postal_code: "0150" }), area)).toBe(false)
  })
})

describe("mergeRecord", () => {
  test("keeps a newer INACTIVE state over an older ACTIVE item", () => {
    const existing = baseRecord({
      status: "INACTIVE",
      date_modified: "2026-11-06T12:00:00+01:00",
    })
    const incoming = baseRecord({
      status: "ACTIVE",
      date_modified: "2026-11-05T10:00:00+01:00",
    })
    expect(mergeRecord(existing, incoming).status).toBe("INACTIVE")
  })

  test("allows a genuinely newer ACTIVE item to win", () => {
    const existing = baseRecord({
      status: "INACTIVE",
      date_modified: "2026-11-05T10:00:00+01:00",
    })
    const incoming = baseRecord({
      status: "ACTIVE",
      date_modified: "2026-11-06T12:00:00+01:00",
    })
    expect(mergeRecord(existing, incoming).status).toBe("ACTIVE")
  })

  test("does not let an older item overwrite a newer one", () => {
    const existing = baseRecord({ title: "Ny tittel", date_modified: "2026-11-06T12:00:00+01:00" })
    const incoming = baseRecord({ title: "Gammel tittel", date_modified: "2026-11-05T10:00:00+01:00" })
    expect(mergeRecord(existing, incoming).title).toBe("Ny tittel")
  })
})

describe("parseUuid", () => {
  const uuid = "11111111-1111-4111-8111-111111111111"
  test("accepts a bare uuid", () => {
    expect(parseUuid(uuid)).toBe(uuid)
  })
  test("accepts feedentry path and full URL", () => {
    expect(parseUuid(`/api/v1/feedentry/${uuid}`)).toBe(uuid)
    expect(parseUuid(`https://pam-stilling-feed.nav.no/api/v1/feedentry/${uuid}`)).toBe(uuid)
    expect(parseUuid(`https://arbeidsplassen.nav.no/stillinger/stilling/${uuid}`)).toBe(uuid)
  })
  test("rejects a non-uuid", () => {
    expect(parseUuid("not-a-job")).toBeNull()
  })
})
