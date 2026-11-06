import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  formatLocations,
  htmlToText,
  lastPathSegment,
  parseFeed,
  toIsoDate,
  visibleHtml,
} from "../src/helpers"
import { FIXTURES } from "./helpers"

const feed = readFileSync(join(FIXTURES, "alpha.rss"), "utf8")

describe("parseFeed", () => {
  const items = parseFeed(feed)

  test("parses every item", () => {
    expect(items).toHaveLength(6)
  })

  test("parses core RSS fields and guid", () => {
    const first = items[0]
    expect(first.title).toBe("Senior Engineer")
    expect(first.description).toContain("Build <strong>great</strong> things.")
    expect(first.link).toBe("https://alpha.teamtailor.com/jobs/1001-senior-engineer")
    expect(first.guid).toBe("11111111-1111-4111-8111-111111111111")
    expect(first.pubDate).toBe("Wed, 04 Nov 2026 07:42:37 +0100")
    expect(first.department).toBe("Engineering")
    expect(first.role).toBe("Engineering")
  })

  test("parses tt:location name, zip, city and country", () => {
    const loc = items[0].locations[0]
    expect(loc).toEqual({
      name: "Trondheim",
      address: "Kongens gate 1",
      zip: "7011",
      city: "Trondheim",
      country: "Norway",
    })
  })

  test("keeps multiple locations", () => {
    expect(items[4].locations.map((l) => l.name)).toEqual(["Trondheim", "Oslo"])
  })

  test("an item without locations has an empty array", () => {
    expect(items[5].locations).toEqual([])
  })

  test("formats multiple locations with semicolons", () => {
    expect(formatLocations(items[4].locations)).toBe("Trondheim, Norway; Oslo, Norway")
  })

  test("decodes XML entities and numeric references", () => {
    const xml = `<rss><channel><item>
      <title>K&#248;nstrukt&#xF8;r &amp; leder</title>
      <description>&lt;p&gt;A &amp; B&lt;/p&gt;</description>
      <link>https://example.teamtailor.com/jobs/9-utvikler</link>
    </item></channel></rss>`
    const [item] = parseFeed(xml)
    expect(item.title).toBe("Kønstruktør & leder")
    expect(item.description).toBe("<p>A & B</p>")
  })

  test("parses CDATA descriptions", () => {
    const xml = `<rss><channel><item>
      <title>Utvikler</title>
      <description><![CDATA[<p>CDATA body</p>]]></description>
    </item></channel></rss>`
    expect(parseFeed(xml)[0].description).toBe("<p>CDATA body</p>")
  })
})

describe("htmlToText", () => {
  test("preserves paragraph and list breaks", () => {
    const text = htmlToText("<p>One</p><p>Two</p><ul><li>Three</li><li>Four</li></ul>")
    expect(text).toBe("One\nTwo\nThree\nFour")
  })

  test("drops hidden script blocks and comments", () => {
    expect(htmlToText("<p>Visible</p><script>hiddenword</script><!-- secret -->")).toBe("Visible")
  })

  test("visibleHtml removes display:none and hidden elements", () => {
    expect(visibleHtml('<p>Visible</p><span style="display:none">no</span><div hidden>no</div>')).toBe(
      "<p>Visible</p>",
    )
  })
})

describe("dates and ids", () => {
  test("toIsoDate converts RFC-822 dates", () => {
    expect(toIsoDate("Wed, 04 Nov 2026 07:42:37 +0100")).toBe("2026-11-04")
    expect(toIsoDate("not a date")).toBeNull()
    expect(toIsoDate(null)).toBeNull()
  })

  test("lastPathSegment reads the posting slug", () => {
    expect(lastPathSegment("https://alpha.teamtailor.com/jobs/1001-senior-engineer?x=1")).toBe(
      "1001-senior-engineer",
    )
    expect(lastPathSegment(null)).toBeNull()
  })
})
