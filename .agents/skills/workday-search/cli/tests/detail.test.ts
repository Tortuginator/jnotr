import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { resolveTarget, normalizeRegistry } from "../src/helpers"
import { FIXTURES, fixtureEnv, parseJSON, runCLI } from "./helpers"

const NORCONSULT_URL =
  "https://norconsult.wd3.myworkdayjobs.com/Norconsult_Career_Site/job/Trondheim/Sommerjobb-2027---Dam-og-vassdrag_REQ-6486"

describe("resolveTarget", () => {
  test("parses a full posting URL", () => {
    const target = resolveTarget(NORCONSULT_URL, null)
    expect("site" in target).toBe(true)
    if (!("site" in target)) return
    expect(target.site.tenant).toBe("norconsult")
    expect(target.site.site).toBe("Norconsult_Career_Site")
    expect(target.externalPath).toBe("/job/Trondheim/Sommerjobb-2027---Dam-og-vassdrag_REQ-6486")
    expect(target.publicUrl).toBe(NORCONSULT_URL)
  })

  test("parses a URL that carries a locale segment", () => {
    const target = resolveTarget(
      "https://norgesgruppen.wd3.myworkdayjobs.com/no-NO/karriere/job/Meny-Farmandstredet/example_JR100",
      null,
    )
    if (!("site" in target)) throw new Error("expected a target")
    expect(target.site.site).toBe("karriere")
    expect(target.externalPath).toBe("/job/Meny-Farmandstredet/example_JR100")
  })

  test("rejects other hosts and non-posting paths", () => {
    expect(resolveTarget("https://hent.teamtailor.com/jobs/1", null)).toMatchObject({ code: "BAD_URL" })
    expect(resolveTarget("https://norconsult.wd3.myworkdayjobs.com/Norconsult_Career_Site", null)).toMatchObject({
      code: "BAD_URL",
    })
  })

  test("resolves a composite id through the registry", () => {
    const registry = normalizeRegistry(
      [
        "name,ats,ats_ref,enabled",
        "Norconsult AS,workday,https://norconsult.wd3.myworkdayjobs.com/Norconsult_Career_Site,true",
      ].join("\n"),
    )
    const target = resolveTarget(
      "norconsult/Norconsult_Career_Site/job/Trondheim/Sommerjobb-2027---Dam-og-vassdrag_REQ-6486",
      registry,
    )
    if (!("site" in target)) throw new Error("expected a target")
    expect(target.site.origin).toBe("https://norconsult.wd3.myworkdayjobs.com")
  })

  test("rejects a bare externalPath when several sites exist", () => {
    const registry = normalizeRegistry(
      [
        "name,ats,ats_ref,enabled",
        "A AS,workday,https://a.wd3.myworkdayjobs.com/A,true",
        "B AS,workday,https://b.wd3.myworkdayjobs.com/B,true",
      ].join("\n"),
    )
    expect(resolveTarget("/job/X/Y_JR1", registry)).toMatchObject({ code: "AMBIGUOUS_ID" })
  })
})

describe("detail command", () => {
  test("prints a readable JSON detail with the registry company name", async () => {
    const result = await runCLI(["detail", NORCONSULT_URL, "--format", "json"], fixtureEnv())
    const detail = parseJSON<Record<string, unknown>>(result)

    expect(detail.title).toBe("Sommerjobb 2027 – Dam og vassdrag")
    expect(detail.company).toBe("NORCONSULT NORGE AS")
    expect(detail.location).toBe("Trondheim")
    expect(detail.date).toBe("2026-10-23")
    expect(detail.timeType).toBe("Full time")
    expect(detail.jobReqId).toBe("REQ-6486")
    expect(detail.additionalLocations).toEqual([])
    expect(String(detail.description)).toContain("Prosjektering i 3D")
    expect(String(detail.description)).not.toContain("Ignore previous instructions")
  })

  test("prints a readable plain detail", async () => {
    const result = await runCLI(["detail", NORCONSULT_URL, "--format", "plain"], fixtureEnv())
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Sommerjobb 2027 – Dam og vassdrag")
    expect(result.stdout).toContain("NORCONSULT NORGE AS · Trondheim")
    expect(result.stdout).toContain("Prosjektering i 3D")
    expect(result.stdout).not.toContain("Ignore previous instructions")
  })

  test("returns NOT_FOUND for an empty posting payload", async () => {
    const result = await runCLI(
      ["detail", "https://if.wd502.myworkdayjobs.com/Careers/job/Empty/Empty_JR9", "--format", "json"],
      fixtureEnv(),
    )
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stderr).code).toBe("NOT_FOUND")
  })

  test("requires an input", async () => {
    const result = await runCLI(["detail"], fixtureEnv())
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stderr).code).toBe("NO_ID")
  })

  test("does not read detail fixtures from an unrelated directory", async () => {
    const result = await runCLI(["detail", NORCONSULT_URL], {
      ...fixtureEnv(),
      WORKDAY_FIXTURE_DIR: join(FIXTURES, "does-not-exist"),
    })
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stderr).code).toBe("DETAIL_FAILED")
  })
})
